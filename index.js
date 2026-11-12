const { onUserCreated } = require("firebase-functions/v2/identity");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
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
