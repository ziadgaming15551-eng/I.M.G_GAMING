      });
    }

    // Achievement progress documents and earned documents.
    let newlyUnlocked = 0;
    for (const change of changes) {
      transaction.set(change.progressRef, {
        achievementId: change.achievement.id,
        event: eventName,
        progress: change.progress,
        target: change.achievement.condition.target,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });

      if (!change.unlocked) continue;

      newlyUnlocked++;
      xpReward += change.achievement.reward?.xp || 0;
      coinReward += change.achievement.reward?.coins || 0;

      transaction.create(change.earnedRef, {
        achievementId: change.achievement.id,
        title: change.achievement.title,
        rarity: change.achievement.rarity,
        reward: change.achievement.reward || {},
        completedAt: FieldValue.serverTimestamp()
      });
    }

    const oldCompleted = player.achievementsCompleted || 0;
    const newCompleted = Math.min(150, oldCompleted + newlyUnlocked);
    const secretUnlocked = !secretSnapshot.exists && newCompleted >= 150;

    if (secretUnlocked) {
      coinReward += SECRET_ACHIEVEMENT.reward.coins || 0;
      transaction.create(secretRef, {
        achievementId: SECRET_ACHIEVEMENT.id,
        title: SECRET_ACHIEVEMENT.title,
        rarity: "Secret",
        reward: SECRET_ACHIEVEMENT.reward,
        completedAt: FieldValue.serverTimestamp()
      });
    }

    // Award XP through the same level/boost/milestone path as other XP grants.
    if (xpReward > 0) {
      grantXpInTransaction(transaction, uid, player, xpReward);
    }

    if (newlyUnlocked > 0 || secretUnlocked || coinReward > 0) {
      const actualCoins = grantCoinsInTransaction(player, coinReward);
      transaction.update(playerDocument, {
        coins: (player.coins || 0) + actualCoins,
        achievementsCompleted: newCompleted,
        secretAchievementUnlocked: secretUnlocked || player.secretAchievementUnlocked === true,
        title: secretUnlocked ? "THE LEGEND" : (player.title || null),
        exclusiveFrame: secretUnlocked
          ? "the_legend_royal_gold"
          : (player.exclusiveFrame || null),
        updatedAt: FieldValue.serverTimestamp()
      });

      transaction.set(publicProfileRef(uid), {
        uid,
        displayName: player.displayName || "Player",
        avatarId: player.avatarId || "default",
        level: xpReward > 0 && player.level < MAX_LEVEL
          ? getLevelData((player.totalXp || 0) + (isBoostActive(player.activeXpBoost) ? xpReward * 2 : xpReward)).level
          : (player.level || 1),
        totalXp: xpReward > 0 && player.level < MAX_LEVEL
          ? (player.totalXp || 0) + (isBoostActive(player.activeXpBoost) ? xpReward * 2 : xpReward)
          : (player.totalXp || 0),
        achievementsCompleted: newCompleted,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });

      transaction.set(globalEntryRef(uid), {
        uid,
        displayName: player.displayName || "Player",
        avatarId: player.avatarId || "default",
        level: xpReward > 0 && player.level < MAX_LEVEL
          ? getLevelData((player.totalXp || 0) + (isBoostActive(player.activeXpBoost) ? xpReward * 2 : xpReward)).level
          : (player.level || 1),
        totalXp: xpReward > 0 && player.level < MAX_LEVEL
          ? (player.totalXp || 0) + (isBoostActive(player.activeXpBoost) ? xpReward * 2 : xpReward)
          : (player.totalXp || 0),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }

    transaction.create(receiptRef, {
      event: eventName,
      eventId,
      createdAt: FieldValue.serverTimestamp(),
      unlockedCount: newlyUnlocked
    });

    return {
      unlocked: newlyUnlocked,
      secretUnlocked,
      achievementsCompleted: newCompleted,
      xpReward,
      coinReward
    };
  });

  // Keep the "complete N achievements" meta-achievement synchronized without
  // allowing an infinite self-trigger when that meta-achievement unlocks.
  if (
    eventName !== "achievements_completed" &&
    eventResult.unlocked > 0 &&
    Number.isFinite(eventResult.achievementsCompleted)
  ) {
    const metaResult = await awardAchievementEvent(uid, "achievements_completed", {
      eventId: `meta-${eventName}-${eventId}`,
      amount: eventResult.unlocked,
      value: eventResult.achievementsCompleted
    });
    eventResult.metaUnlocked = metaResult.unlocked || 0;
  }

  return eventResult;
}

// ------------------------------
// PLAYER CREATION (AUTH V1 TRIGGER)
// ------------------------------

exports.createPlayerProfile = functionsV1.auth.user().onCreate(async (user) => {
  const uid = user.uid;
  const pRef = playerRef(uid);
  const ppRef = publicProfileRef(uid);
  const entryRef = globalEntryRef(uid);
  const displayName = (user.displayName || "Player").trim().slice(0, 24) || "Player";

  await db.runTransaction(async (transaction) => {
    const existing = await transaction.get(pRef);
    if (existing.exists) return;

    const now = FieldValue.serverTimestamp();
    const initialPlayer = {
      uid,
      displayName,
      avatarId: "default",
      level: 1,
      xp: 0,
      totalXp: 0,
      xpToNextLevel: 100,
      coins: 0,
      achievementsCompleted: 0,
      attendanceStreak: 0,
      lastAttendanceDay: null,
      activeXpBoost: null,
      activeCoinsBoost: null,
      activeGameSessionId: null,
      createdAt: now,
      updatedAt: now
    };

    transaction.create(pRef, initialPlayer);
    transaction.set(ppRef, {
      uid, displayName, avatarId: "default", level: 1,
      totalXp: 0, achievementsCompleted: 0, createdAt: now, updatedAt: now
    });
    transaction.set(entryRef, {
      uid, displayName, avatarId: "default", level: 1,
      totalXp: 0, createdAt: now, updatedAt: now
    });
  });

  await awardAchievementEvent(uid, "site_login", {
    eventId: `account-created-${uid}`,
    amount: 1,
    value: 1
  });
});

// ------------------------------
// PLAYER PROFILE UPDATE
// ------------------------------

exports.updatePlayerProfile = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");

  const uid = request.auth.uid;
  const displayName = String(request.data?.displayName || "").trim();
  const avatarId = String(request.data?.avatarId || "default").trim();

  if (displayName.length < 2 || displayName.length > 24) {
    throw new HttpsError("invalid-argument", "Display name must be 2–24 characters.");
  }
  // Avatar IDs are identifiers from the site's local avatar library, never URLs.
  if (!/^(default|avatar_[0-9]{2})$/.test(avatarId)) {
    throw new HttpsError("invalid-argument", "Invalid avatar ID.");
  }

  const pRef = playerRef(uid);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(pRef);
    if (!snapshot.exists) throw new HttpsError("failed-precondition", "Player profile missing.");
    transaction.update(pRef, {
      displayName,
      avatarId,
      updatedAt: FieldValue.serverTimestamp()
    });
    transaction.set(publicProfileRef(uid), {
      uid, displayName, avatarId,
      level: snapshot.data().level || 1,
      totalXp: snapshot.data().totalXp || 0,
      achievementsCompleted: snapshot.data().achievementsCompleted || 0,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    transaction.set(globalEntryRef(uid), {
      uid, displayName, avatarId,
      level: snapshot.data().level || 1,
      totalXp: snapshot.data().totalXp || 0,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  });

  const results = await Promise.all([
    awardAchievementEvent(uid, "display_name_set", {
      eventId: `profile-name-${Date.now()}`, amount: 1, value: 1
    }),
    awardAchievementEvent(uid, "avatar_equipped", {
      eventId: `profile-avatar-${Date.now()}`, amount: 1, value: 1
    }),
    awardAchievementEvent(uid, "profile_completed", {
      eventId: `profile-complete-${Date.now()}`, amount: 1, value: 1
    })
  ]);

  return { success: true, displayName, avatarId, achievementsUnlocked: results.reduce((n, r) => n + (r.unlocked || 0), 0) };
});

// ------------------------------
// DAILY ATTENDANCE: 50 COINS + 500 ON DAY 7
// ------------------------------

exports.dailyCheckIn = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");

  const uid = request.auth.uid;
  const today = getEgyptDate();
  const pRef = playerRef(uid);
  const attendanceRef = db.collection("attendance").doc(uid)
    .collection("days").doc(today);
  const transactionRef = db.collection("transactions").doc(uid)
    .collection("items").doc();

  const result = await db.runTransaction(async (transaction) => {
    const [attendanceSnapshot, playerSnapshot] = await Promise.all([
      transaction.get(attendanceRef),
      transaction.get(pRef)
    ]);

    if (attendanceSnapshot.exists) {
      const prior = attendanceSnapshot.data();
      return {
        success: true,
        alreadyCheckedIn: true,
        streak: prior.streak || 0,
        dailyReward: prior.dailyReward || 0,
        weeklyReward: prior.weeklyReward || 0,
        totalReward: prior.actualReward ?? prior.totalReward ?? 0
      };
    }
    if (!playerSnapshot.exists) {
      throw new HttpsError("failed-precondition", "Player profile does not exist.");
    }

    const player = playerSnapshot.data();
    const previousDay = player.lastAttendanceDay;
    const streak = previousDay && dayDifference(previousDay, today) === 1
      ? (player.attendanceStreak || 0) + 1
      : 1;

    const dailyReward = 50;
    const weeklyReward = streak % 7 === 0 ? 500 : 0;
    const baseReward = dailyReward + weeklyReward;
    const actualReward = grantCoinsInTransaction(player, baseReward);

    transaction.update(pRef, {
      coins: (player.coins || 0) + actualReward,
      attendanceStreak: streak,
      lastAttendanceDay: today,
      updatedAt: FieldValue.serverTimestamp()
    });
    transaction.create(attendanceRef, {
      uid, date: today, streak, dailyReward, weeklyReward,
      baseReward, actualReward, createdAt: FieldValue.serverTimestamp()
    });
    transaction.create(transactionRef, {
      type: "attendance", amount: actualReward, baseAmount: baseReward,
      dailyReward, weeklyReward, createdAt: FieldValue.serverTimestamp()
    });

    return {
      success: true, alreadyCheckedIn: false, streak,
      dailyReward, weeklyReward, totalReward: actualReward
    };
  });

  // Re-run safely on duplicate requests: each event receipt is idempotent.
  await Promise.all([
    awardAchievementEvent(uid, "daily_checkin", {
      eventId: `checkin-${today}`, amount: 1, value: 1
    }),
    awardAchievementEvent(uid, "attendance_streak", {
      eventId: `attendance-streak-${today}`, amount: 1, value: result.streak || 1
    }),
    awardAchievementEvent(uid, "coins_earned", {
      eventId: `attendance-coins-${today}`, amount: result.totalReward || 0, value: result.totalReward || 0
    })
  ]);
  return result;
});

// ------------------------------
// ADMIN XP GRANT
// ------------------------------

exports.adminGrantXp = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  await verifyAdmin(request.auth.uid);

  const uid = request.data?.uid;
  const amount = safeInteger(request.data?.amount, 1, 10000, "XP amount");
  if (typeof uid !== "string" || uid.length < 10 || uid.length > 128) {
    throw new HttpsError("invalid-argument", "Invalid player UID.");
  }

  const pRef = playerRef(uid);
  const result = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(pRef);
    if (!snapshot.exists) throw new HttpsError("not-found", "Player not found.");
    return grantXpInTransaction(transaction, uid, snapshot.data(), amount);
  });

  if (result.level) {
    await awardAchievementEvent(uid, "player_level", {
      eventId: `admin-xp-${randomBytes(8).toString("hex")}`,
      amount: 1, value: result.level
    });
  }
  return { success: true, ...result };
});

// ------------------------------
// ACTIVATE XP / COINS BOOSTS
// ------------------------------

async function activateBoostForUser(uid, boostId, expectedType) {
  if (typeof boostId !== "string" || !/^[A-Za-z0-9_-]{1,150}$/.test(boostId)) {
    throw new HttpsError("invalid-argument", "Invalid boost ID.");
  }

  const pRef = playerRef(uid);
  const inventoryRef = inventoryItemsRef(uid).doc(boostId);
  // Backward compatibility for milestone boosts stored by the previous backend.
  const legacyBoostRef = db.collection("boosts").doc(uid)
    .collection("items").doc(boostId);

  const result = await db.runTransaction(async (transaction) => {
    const [playerSnapshot, inventorySnapshot, legacySnapshot] = await Promise.all([
      transaction.get(pRef),
      transaction.get(inventoryRef),
      transaction.get(legacyBoostRef)
    ]);

    if (!playerSnapshot.exists) throw new HttpsError("not-found", "Player not found.");
    const player = playerSnapshot.data();
    const boostSnapshot = inventorySnapshot.exists ? inventorySnapshot : legacySnapshot;
    const boostRef = inventorySnapshot.exists ? inventoryRef : legacyBoostRef;

    if (!boostSnapshot.exists) throw new HttpsError("not-found", "Boost not found.");
    const boost = boostSnapshot.data();

    if (boost.type !== expectedType || boost.status !== "stored") {
      throw new HttpsError("failed-precondition", "This boost is not available.");
    }

    const activeKey = expectedType === "xp_boost" ? "activeXpBoost" : "activeCoinsBoost";
    if (isBoostActive(player[activeKey])) {
      throw new HttpsError("failed-precondition", "A boost of this type is already active.");
    }

    const durationMinutes = Number(boost.durationMinutes || (boost.durationHours || 1) * 60);
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 1440) {
      throw new HttpsError("failed-precondition", "Invalid boost duration.");
    }

    const now = Date.now();
    const activatedAt = Timestamp.fromMillis(now);
    const expiresAt = Timestamp.fromMillis(now + durationMinutes * 60000);

    transaction.update(boostRef, {
      status: "used", activatedAt, expiresAt
    });
    transaction.update(pRef, {
      [activeKey]: { multiplier: 2, activatedAt, expiresAt },
      updatedAt: FieldValue.serverTimestamp()
    });

    return {
      success: true, type: expectedType, multiplier: 2,
      durationMinutes, expiresAt: expiresAt.toDate().toISOString()
    };
  });

  await awardAchievementEvent(uid, expectedType === "xp_boost"
    ? "xp_boost_activated" : "coins_boost_activated", {
      eventId: `${expectedType}-${boostId}`,
      amount: 1, value: 1
    });

  return result;
}

exports.activateXpBoost = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  return activateBoostForUser(request.auth.uid, request.data?.boostId, "xp_boost");
});

exports.activateCoinsBoost = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  return activateBoostForUser(request.auth.uid, request.data?.boostId, "coins_boost");
});

// ------------------------------
// ADMIN: CREATE ONE-TIME REDEEM CODE
// ------------------------------

exports.adminCreateRedeemCode = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  await verifyAdmin(request.auth.uid);

  const data = request.data || {};
  const type = data.type;
  if (!["coins", "xp_boost", "coins_boost"].includes(type)) {
    throw new HttpsError("invalid-argument", "Invalid code type.");
  }

  let reward = {};
  if (type === "coins") {
    if (!ALLOWED_COIN_REWARDS.includes(data.amount)) {
      throw new HttpsError("invalid-argument", "Invalid coin amount.");
    }
    reward = { amount: data.amount };
  } else {
    const durationHours = safeInteger(data.durationHours, 1, 24, "boost duration");
    reward = { multiplier: 2, durationHours };
  }

  const code = "IMG-" + randomBytes(5).toString("hex").toUpperCase();
  const codeHash = hashRedeemCode(code);
  const codeRef = db.collection("redeemCodes").doc(codeHash);
  const logRef = db.collection("adminLogs").doc();

  await db.runTransaction(async (transaction) => {
    transaction.create(codeRef, {
      type, ...reward, used: false, usedBy: null,
      createdBy: request.auth.uid,
      createdAt: FieldValue.serverTimestamp()
    });
    transaction.create(logRef, {
      adminUid: request.auth.uid,
      action: "create_redeem_code",
      codeType: type,
      createdAt: FieldValue.serverTimestamp()
    });
  });

  return { success: true, code, type, ...reward };
});

// ------------------------------
// PLAYER: REDEEM ONE-TIME CODE
// ------------------------------

exports.redeemStoreCode = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");

  const uid = request.auth.uid;
  const rawCode = request.data?.code;
  if (typeof rawCode !== "string" || rawCode.trim().length < 8 || rawCode.trim().length > 40) {
    throw new HttpsError("invalid-argument", "Invalid code.");
  }

  const codeHash = hashRedeemCode(rawCode);
  const codeRef = db.collection("redeemCodes").doc(codeHash);
  const pRef = playerRef(uid);
  const inventoryRef = inventoryItemsRef(uid).doc();
  const transactionRef = db.collection("transactions").doc(uid)
    .collection("items").doc();

  const result = await db.runTransaction(async (transaction) => {
    const [codeSnapshot, playerSnapshot] = await Promise.all([
      transaction.get(codeRef), transaction.get(pRef)
    ]);

    if (!codeSnapshot.exists) throw new HttpsError("not-found", "Code not found.");
    if (!playerSnapshot.exists) throw new HttpsError("failed-precondition", "Player profile missing.");

    const codeData = codeSnapshot.data();
    if (codeData.used === true) {
      throw new HttpsError("already-exists", "This code has already been redeemed.");
    }

    const now = FieldValue.serverTimestamp();
    const player = playerSnapshot.data();

    if (codeData.type === "coins") {
      if (!ALLOWED_COIN_REWARDS.includes(codeData.amount)) {
        throw new HttpsError("failed-precondition", "Invalid reward configuration.");
      }
      const actualAmount = grantCoinsInTransaction(player, codeData.amount);
      transaction.update(pRef, {
        coins: (player.coins || 0) + actualAmount,
        updatedAt: now
      });
      transaction.create(transactionRef, {
        type: "redeem_code", amount: actualAmount,
        baseAmount: codeData.amount, createdAt: now
      });
    } else if (codeData.type === "xp_boost" || codeData.type === "coins_boost") {
      const durationHours = codeData.durationHours;
      if (!Number.isInteger(durationHours) || durationHours < 1 || durationHours > 24 || codeData.multiplier !== 2) {
        throw new HttpsError("failed-precondition", "Invalid boost configuration.");
      }
      transaction.create(inventoryRef, {
        type: codeData.type, multiplier: 2,
        durationHours, durationMinutes: durationHours * 60,
        status: "stored", source: "redeem_code", createdAt: now
      });
      transaction.create(transactionRef, {
        type: "redeem_code", rewardType: codeData.type,
        durationHours, createdAt: now
      });
    } else {
      throw new HttpsError("failed-precondition", "Unsupported code reward.");
    }

    transaction.update(codeRef, {
      used: true, usedBy: uid, usedAt: now
    });

    return {
      success: true, rewardType: codeData.type,
      amount: codeData.type === "coins" ? codeData.amount : null,
      message: "Code redeemed successfully."
    };
  });

  if (result.rewardType === "coins") {
    await awardAchievementEvent(uid, "coins_earned", {
      eventId: `redeem-${codeHash}`, amount: result.amount, value: result.amount
    });
  }
  return result;
});

// ------------------------------
// READ-ONLY CALLABLE: ACHIEVEMENT CATALOG METADATA
// ------------------------------

exports.getAchievementCatalog = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  return {
    schemaVersion: achievementCatalog.schemaVersion,
    baseAchievementCount: achievementCatalog.baseAchievementCount,
    secretAchievementCount: achievementCatalog.secretAchievementCount,
    rarityDistribution: achievementCatalog.rarityDistribution,
    rewardPolicy: achievementCatalog.rewardPolicy,
    achievements: BASE_ACHIEVEMENTS.map((item) => ({
      id: item.id,
      title: item.title,
      description: item.description,
      category: item.category,
      rarity: item.rarity,
      scope: item.scope,
      condition: item.condition,
      reward: item.reward,
      status: item.status
    }))
  };
});const { onUserCreated } = require("firebase-functions/v2/identity");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { randomBytes, createHash } = require("node:crypto");
const { initializeApp } = require("firebase-admin/app");
const {
  getFirestore,
  FieldValue,
  Timestamp
} = require("firebase-admin/firestore");

initializeApp();

const db = getFirestore();
const REGION = "europe-west1";
const TIME_ZONE = "Africa/Cairo";
const MAX_LEVEL = 100;
const XP_BOOST_DURATION = 60 * 60 * 1000;

// ------------------------------
// DATE HELPERS
// ------------------------------

function getEgyptDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const values = {};
  for (const part of parts) {
    values[part.type] = part.value;
  }

  return `${values.year}-${values.month}-${values.day}`;
}

function dayDifference(first, second) {
  const a = new Date(`${first}T00:00:00Z`);
  const b = new Date(`${second}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

// ------------------------------
// LEVEL SYSTEM
// ------------------------------

function getLevelData(totalXp) {
  let level = 1;
  let remaining = Math.max(0, totalXp);

  while (level < MAX_LEVEL) {
    const required = level * 100;

    if (remaining < required) {
      return {
        level,
        xp: remaining,
        xpToNextLevel: required
      };
    }

    remaining -= required;
    level++;
  }

  return {
    level: MAX_LEVEL,
    xp: 0,
    xpToNextLevel: 0
  };
}

// Must be called inside a Firestore transaction.
// totalXp is the player's lifetime XP.
function grantXpInTransaction(transaction, uid, player, baseAmount) {
  const oldLevel = player.level || 1;
  const now = Date.now();

  let multiplier = 1;
  const activeBoost = player.activeXpBoost;

  if (
    activeBoost &&
    activeBoost.multiplier === 2 &&
    activeBoost.expiresAt &&
    activeBoost.expiresAt.toMillis() > now
  ) {
    multiplier = 2;
  }

  const amount = Math.max(0, Math.floor(baseAmount));

  if (oldLevel >= MAX_LEVEL || amount === 0) {
    return {
      addedXp: 0,
      level: oldLevel,
      leveledUp: false
    };
  }

  const totalXp = (player.totalXp || 0) + amount * multiplier;
  const levelData = getLevelData(totalXp);

  const playerRef = db.collection("players").doc(uid);

  transaction.update(playerRef, {
    totalXp,
    level: levelData.level,
    xp: levelData.xp,
    xpToNextLevel: levelData.xpToNextLevel,
    updatedAt: FieldValue.serverTimestamp()
  });

  // Every 10 levels grants one stored XP boost.
  for (
    let milestone = 10;
    milestone <= levelData.level;
    milestone += 10
  ) {
    if (milestone > oldLevel) {
      const boostRef = db
        .collection("boosts")
        .doc(uid)
        .collection("items")
        .doc();

      transaction.set(boostRef, {
        type: "xp_boost",
        multiplier: 2,
        durationMinutes: 60,
        status: "stored",
        createdAt: FieldValue.serverTimestamp()
      });
    }
  }

  return {
    addedXp: amount * multiplier,
    level: levelData.level,
    leveledUp: levelData.level > oldLevel,
    totalXp
  };
}

// ------------------------------
// PLAYER CREATION
// ------------------------------

exports.createPlayerProfile = onUserCreated(
  { region: REGION },
  async (event) => {
    const user = event.data;
    if (!user) return;

    const uid = user.uid;
    const playerRef = db.collection("players").doc(uid);
    const publicRef = db.collection("publicProfiles").doc(uid);

    const displayName =
      (user.displayName || "Player").trim().slice(0, 24) || "Player";

    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(playerRef);

      if (snapshot.exists) return;

      const now = FieldValue.serverTimestamp();

      transaction.set(playerRef, {
        uid,
        displayName,
        level: 1,
        xp: 0,
        totalXp: 0,
        xpToNextLevel: 100,
        coins: 0,
        achievementsCompleted: 0,
        attendanceStreak: 0,
        lastAttendanceDay: null,
        activeXpBoost: null,
        createdAt: now,
        updatedAt: now
      });

      transaction.set(publicRef, {
        uid,
        displayName,
        avatarId: "default",
        level: 1,
        achievementsCompleted: 0,
        totalXp: 0,
        createdAt: now,
        updatedAt: now
      });
    });
  }
);

// ------------------------------
// DAILY ATTENDANCE
// ------------------------------

exports.dailyCheckIn = onCall(
  { region: REGION },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign in first.");
    }

    const uid = request.auth.uid;
    const today = getEgyptDate();

    const playerRef = db.collection("players").doc(uid);
    const attendanceRef = db
      .collection("attendance")
      .doc(uid)
      .collection("days")
      .doc(today);

    const transactionRef = db
      .collection("transactions")
      .doc(uid)
      .collection("items")
      .doc();

    return db.runTransaction(async (transaction) => {
      const attendanceSnapshot = await transaction.get(attendanceRef);
      const playerSnapshot = await transaction.get(playerRef);

      if (attendanceSnapshot.exists) {
        return {
          success: true,
          alreadyCheckedIn: true,
          dailyReward: 0,
          weeklyReward: 0
        };
      }

      if (!playerSnapshot.exists) {
        throw new HttpsError(
          "failed-precondition",
          "Player profile does not exist."
        );
      }

      const player = playerSnapshot.data();
      const previousDay = player.lastAttendanceDay;

      let streak = 1;

      if (previousDay && dayDifference(previousDay, today) === 1) {
        streak = (player.attendanceStreak || 0) + 1;
      }

      const dailyReward = 50;
      const weeklyReward = streak % 7 === 0 ? 500 : 0;
      const totalReward = dailyReward + weeklyReward;

      transaction.update(playerRef, {
        coins: (player.coins || 0) + totalReward,
        attendanceStreak: streak,
        lastAttendanceDay: today,
        updatedAt: FieldValue.serverTimestamp()
      });

      transaction.set(attendanceRef, {
        uid,
        date: today,
        streak,
        dailyReward,
        weeklyReward,
        totalReward,
        createdAt: FieldValue.serverTimestamp()
      });

      transaction.set(transactionRef, {
        type: "attendance",
        amount: totalReward,
        dailyReward,
        weeklyReward,
        createdAt: FieldValue.serverTimestamp()
      });

      return {
        success: true,
        alreadyCheckedIn: false,
        streak,
        dailyReward,
        weeklyReward,
        totalReward
      };
    });
  }
);

// ------------------------------
// ADMIN-ONLY XP GRANT
// ------------------------------

exports.adminGrantXp = onCall(
  { region: REGION },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign in first.");
    }

    const adminRef = db.collection("admins").doc(request.auth.uid);
    const adminSnapshot = await adminRef.get();

    if (
      !adminSnapshot.exists ||
      adminSnapshot.data().active !== true
    ) {
      throw new HttpsError("permission-denied", "Admin access required.");
    }

    const uid = request.data?.uid;
    const amount = request.data?.amount;

    if (
      typeof uid !== "string" ||
      !Number.isInteger(amount) ||
      amount < 1 ||
      amount > 10000
    ) {
      throw new HttpsError("invalid-argument", "Invalid XP request.");
    }

    const playerRef = db.collection("players").doc(uid);

    return db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(playerRef);

      if (!snapshot.exists) {
        throw new HttpsError("not-found", "Player not found.");
      }

      const result = grantXpInTransaction(
        transaction,
        uid,
        snapshot.data(),
        amount
      );

      return {
        success: true,
        ...result
      };
    });
  }
);

// ------------------------------
// ACTIVATE STORED XP BOOST
// ------------------------------

exports.activateXpBoost = onCall(
  { region: REGION },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign in first.");
    }

    const uid = request.auth.uid;
    const boostId = request.data?.boostId;

    if (typeof boostId !== "string" || !boostId) {
      throw new HttpsError("invalid-argument", "Invalid boost ID.");
    }

    const playerRef = db.collection("players").doc(uid);
    const boostRef = db
      .collection("boosts")
      .doc(uid)
      .collection("items")
      .doc(boostId);

    return db.runTransaction(async (transaction) => {
      const playerSnapshot = await transaction.get(playerRef);
      const boostSnapshot = await transaction.get(boostRef);

      if (!playerSnapshot.exists || !boostSnapshot.exists) {
        throw new HttpsError("not-found", "Player or boost not found.");
      }

      const player = playerSnapshot.data();
      const boost = boostSnapshot.data();

      if (
        boost.type !== "xp_boost" ||
        boost.status !== "stored"
      ) {
        throw new HttpsError(
          "failed-precondition",
          "This boost is not available."
        );
      }

      const currentBoost = player.activeXpBoost;
      const now = Date.now();

      if (
        currentBoost &&
        currentBoost.expiresAt &&
        currentBoost.expiresAt.toMillis() > now
      ) {
        throw new HttpsError(
          "failed-precondition",
          "An XP boost is already active."
        );
      }

      const expiresAt = Timestamp.fromMillis(
        now + XP_BOOST_DURATION
      );

      transaction.update(boostRef, {
        status: "used",
        activatedAt: Timestamp.fromMillis(now),
        expiresAt
      });

      transaction.update(playerRef, {
        activeXpBoost: {
          multiplier: 2,
          activatedAt: Timestamp.fromMillis(now),
          expiresAt
        },
        updatedAt: FieldValue.serverTimestamp()
      });

      return {
        success: true,
        multiplier: 2,
        durationMinutes: 60,
        expiresAt: expiresAt.toDate().toISOString()
      };
    });
  }
);

// ==========================================
// I.M.G GAMING - SECURE REDEEM CODE SYSTEM
// ==========================================

const ALLOWED_COIN_REWARDS = [100, 250, 500, 1000, 2000, 5000];

function hashRedeemCode(code) {
  return createHash("sha256")
    .update(code.trim().toUpperCase())
    .digest("hex");
}

async function verifyAdmin(uid) {
  const snapshot = await db.collection("admins").doc(uid).get();

  if (!snapshot.exists || snapshot.data().active !== true) {
    throw new HttpsError("permission-denied", "Admin access required.");
  }
}

// ADMIN: CREATE A SINGLE-USE CODE
exports.adminCreateRedeemCode = onCall(
  { region: REGION },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign in first.");
    }

    await verifyAdmin(request.auth.uid);

    const data = request.data || {};
    const type = data.type;

    if (!["coins", "xp_boost", "coins_boost"].includes(type)) {
      throw new HttpsError("invalid-argument", "Invalid code type.");
    }

    let reward = {};

    if (type === "coins") {
      const amount = data.amount;

      if (!ALLOWED_COIN_REWARDS.includes(amount)) {
        throw new HttpsError("invalid-argument", "Invalid coin amount.");
      }

      reward = { amount };
    } else {
      const durationHours = data.durationHours;

      if (
        !Number.isInteger(durationHours) ||
        durationHours < 1 ||
        durationHours > 24
      ) {
        throw new HttpsError(
          "invalid-argument",
          "Boost duration must be between 1 and 24 hours."
        );
      }

      reward = {
        multiplier: 2,
        durationHours
      };
    }

    const code =
      "IMG-" + randomBytes(5).toString("hex").toUpperCase();

    const codeHash = hashRedeemCode(code);
    const codeRef = db.collection("redeemCodes").doc(codeHash);

    await db.runTransaction(async (transaction) => {
      transaction.create(codeRef, {
        type,
        ...reward,
        used: false,
        usedBy: null,
        createdBy: request.auth.uid,
        createdAt: FieldValue.serverTimestamp()
      });

      const logRef = db.collection("adminLogs").doc();

      transaction.set(logRef, {
        adminUid: request.auth.uid,
        action: "create_redeem_code",
        codeType: type,
        createdAt: FieldValue.serverTimestamp()
      });
    });

    // The plain code is returned only once.
    return {
      success: true,
      code,
      type,
      ...reward
    };
  }
);

// PLAYER: REDEEM A SINGLE-USE CODE
exports.redeemStoreCode = onCall(
  { region: REGION },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign in first.");
    }

    const uid = request.auth.uid;
    const rawCode = request.data?.code;

    if (
      typeof rawCode !== "string" ||
      rawCode.trim().length < 8 ||
      rawCode.trim().length > 40
    ) {
      throw new HttpsError("invalid-argument", "Invalid code.");
    }

    const codeHash = hashRedeemCode(rawCode);
    const codeRef = db.collection("redeemCodes").doc(codeHash);
    const playerRef = db.collection("players").doc(uid);

    const inventoryRef = db
      .collection("inventory")
      .doc(uid)
      .collection("items")
      .doc();

    const transactionRef = db
      .collection("transactions")
      .doc(uid)
      .collection("items")
      .doc();

    return db.runTransaction(async (transaction) => {
      const codeSnapshot = await transaction.get(codeRef);
      const playerSnapshot = await transaction.get(playerRef);

      if (!codeSnapshot.exists) {
        throw new HttpsError("not-found", "Code not found.");
      }

      if (!playerSnapshot.exists) {
        throw new HttpsError("failed-precondition", "Player profile missing.");
      }

      const codeData = codeSnapshot.data();

      if (codeData.used === true) {
        throw new HttpsError(
          "already-exists",
          "This code has already been redeemed."
        );
      }

      const now = FieldValue.serverTimestamp();
      const player = playerSnapshot.data();

      if (codeData.type === "coins") {
        const amount = codeData.amount;

        if (!ALLOWED_COIN_REWARDS.includes(amount)) {
          throw new HttpsError(
            "failed-precondition",
            "Invalid reward configuration."
          );
        }

        transaction.update(playerRef, {
          coins: (player.coins || 0) + amount,
          updatedAt: now
        });

        transaction.set(transactionRef, {
          type: "redeem_code",
          amount,
          createdAt: now
        });
      } else if (
        codeData.type === "xp_boost" ||
        codeData.type === "coins_boost"
      ) {
        const durationHours = codeData.durationHours;

        if (
          !Number.isInteger(durationHours) ||
          durationHours < 1 ||
          durationHours > 24 ||
          codeData.multiplier !== 2
        ) {
          throw new HttpsError(
            "failed-precondition",
            "Invalid boost configuration."
          );
        }

        transaction.set(inventoryRef, {
          type: codeData.type,
          multiplier: 2,
          durationHours,
          durationMinutes: durationHours * 60,
          status: "stored",
          source: "redeem_code",
          createdAt: now
        });

        transaction.set(transactionRef, {
          type: "redeem_code",
          rewardType: codeData.type,
          durationHours,
          createdAt: now
        });
      } else {
        throw new HttpsError(
          "failed-precondition",
          "Unsupported code reward."
        );
      }

      transaction.update(codeRef, {
        used: true,
        usedBy: uid,
        usedAt: now
      });

      return {
        success: true,
        rewardType: codeData.type,
        amount: codeData.type === "coins" ? codeData.amount : null,
        message: "Code redeemed successfully."
      };
    });
  }
);
