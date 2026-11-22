'use strict';

// I.M.G GAMING - Firebase Functions backend (Node.js 20)
// This backend intentionally does NOT accept arbitrary game events from clients.
// Competitive/gameplay achievements remain locked until a game has trusted server validation.

const crypto = require('node:crypto');
const functionsV1 = require('firebase-functions/v1');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const catalog = require('./achievement-catalog.json');

initializeApp();
const db = getFirestore();

const REGION = 'europe-west1';
const TIME_ZONE = 'Africa/Cairo';
const MAX_LEVEL = 100;
const DAILY_COINS = 50;
const WEEKLY_STREAK_BONUS = 500;

const ALLOWED_COIN_REWARDS = [
  100, 250, 500, 1000, 2000, 5000
];

const BASE_ACHIEVEMENTS = Array.isArray(catalog.achievements)
  ? catalog.achievements
  : [];

const SECRET_ACHIEVEMENT = catalog.secretAchievement;

if (BASE_ACHIEVEMENTS.length !== 150 || !SECRET_ACHIEVEMENT) {
  throw new Error(
    'Achievement catalog must contain exactly 150 base achievements and one secret achievement.'
  );
}

// ------------------------------------
// FIRESTORE REFERENCES
// ------------------------------------

const playerRef = (uid) =>
  db.collection('players').doc(uid);

const publicProfileRef = (uid) =>
  db.collection('publicProfiles').doc(uid);

const globalEntryRef = (uid) =>
  db.collection('leaderboards')
    .doc('global')
    .collection('entries')
    .doc(uid);

const inventoryRef = (uid) =>
  db.collection('inventory')
    .doc(uid)
    .collection('items');

const achievementProgressRef = (uid, id) =>
  db.collection('achievementProgress')
    .doc(uid)
    .collection('items')
    .doc(id);

const playerAchievementRef = (uid, id) =>
  db.collection('playerAchievements')
    .doc(uid)
    .collection('items')
    .doc(id);

const achievementReceiptRef = (uid, id) =>
  db.collection('achievementReceipts')
    .doc(uid)
    .collection('items')
    .doc(id);

// ------------------------------------
// GENERAL HELPERS
// ------------------------------------

function requireAuth(request) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in first.');
  }

  return request.auth.uid;
}

function safeInteger(value, min, max, label) {
  if (
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new HttpsError(
      'invalid-argument',
      `Invalid ${label}.`
    );
  }

  return value;
}

function egyptDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts.map((p) => [p.type, p.value])
  );

  return `${values.year}-${values.month}-${values.day}`;
}

function dayDifference(previous, current) {
  const a = Date.parse(`${previous}T00:00:00Z`);
  const b = Date.parse(`${current}T00:00:00Z`);

  return Math.round((b - a) / 86400000);
}

function activeBoost(boost, now = Date.now()) {
  if (!boost || !boost.expiresAt) {
    return false;
  }

  const expiry =
    typeof boost.expiresAt.toMillis === 'function'
      ? boost.expiresAt.toMillis()
      : new Date(boost.expiresAt).getTime();

  return Number.isFinite(expiry) && expiry > now;
}

function nextLevelCost(level) {
  if (level === 1) return 100;
  if (level === 2) return 150;
  if (level === 3 || level === 4) return 200;

  return 300 + (level - 5) * 100;
}

// ------------------------------------
// PUBLIC PROFILE AND LEADERBOARD SYNC
// ------------------------------------

function addPublicRankingWrites(
  transaction,
  uid,
  player,
  patch = {}
) {
  const level = patch.level ?? player.level ?? 1;
  const totalXp = patch.totalXp ?? player.totalXp ?? 0;

  const displayName =
    patch.displayName ?? player.displayName ?? 'Player';

  const avatarId =
    patch.avatarId ?? player.avatarId ?? 'default';

  const achievementsCompleted =
    patch.achievementsCompleted ??
    player.achievementsCompleted ??
    0;

  transaction.set(
    publicProfileRef(uid),
    {
      uid,
      displayName,
      avatarId,
      level,
      totalXp,
      achievementsCompleted,
      updatedAt: FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  transaction.set(
    globalEntryRef(uid),
    {
      uid,
      displayName,
      avatarId,
      level,
      totalXp,
      updatedAt: FieldValue.serverTimestamp()
    },
    { merge: true }
  );
}

// ------------------------------------
// XP AND LEVEL SYSTEM
// ------------------------------------

function grantXpInTransaction(
  transaction,
  uid,
  player,
  requestedAmount
) {
  if (
    !Number.isSafeInteger(requestedAmount) ||
    requestedAmount <= 0
  ) {
    return {
      requestedXp: 0,
      awardedXp: 0,
      level: player.level || 1,
      levelsGained: 0,
      milestoneBoosts: []
    };
  }

  let level = Math.min(
    MAX_LEVEL,
    Math.max(1, player.level || 1)
  );

  let xp = Math.max(0, player.xp || 0);
  let totalXp = Math.max(0, player.totalXp || 0);

  const boosted = activeBoost(player.activeXpBoost);

  let remaining =
    requestedAmount * (boosted ? 2 : 1);

  let awardedXp = 0;
  let levelsGained = 0;

  const milestoneBoosts = [];

  while (remaining > 0 && level < MAX_LEVEL) {
    const needed = nextLevelCost(level) - xp;

    const add = Math.min(remaining, needed);

    xp += add;
    remaining -= add;

    awardedXp += add;
    totalXp += add;

    if (xp >= nextLevelCost(level)) {
      xp = 0;
      level += 1;
      levelsGained += 1;

      // Every tenth level grants a stored XP boost.
      if (level % 10 === 0) {
        const boostId = `milestone-xp-${level}`;

        const boostDoc =
          inventoryRef(uid).doc(boostId);

        transaction.set(
          boostDoc,
          {
            type: 'xp_boost',
            multiplier: 2,
            durationMinutes: 60,
            status: 'stored',
            source: 'level_milestone',
            milestoneLevel: level,
            createdAt: FieldValue.serverTimestamp()
          },
          { merge: true }
        );

        milestoneBoosts.push({
          id: boostId,
          level
        });
      }
    }
  }

  transaction.update(
    playerRef(uid),
    {
      level,
      xp,
      totalXp,
      xpToNextLevel:
        level >= MAX_LEVEL
          ? 0
          : nextLevelCost(level) - xp,
      updatedAt: FieldValue.serverTimestamp()
    }
  );

  addPublicRankingWrites(
    transaction,
    uid,
    player,
    { level, totalXp }
  );

  return {
    requestedXp: requestedAmount,
    awardedXp,
    level,
    levelsGained,
    milestoneBoosts
  };
}

// ------------------------------------
// COIN SYSTEM
// ------------------------------------

function grantCoinsInTransaction(player, requestedAmount) {
  if (
    !Number.isSafeInteger(requestedAmount) ||
    requestedAmount <= 0
  ) {
    return 0;
  }

  return requestedAmount *
    (activeBoost(player.activeCoinsBoost) ? 2 : 1);
}

// ------------------------------------
// ADMIN SECURITY
// ------------------------------------

async function verifyAdmin(uid) {
  const snapshot = await db
    .collection('admins')
    .doc(uid)
    .get();

  if (
    !snapshot.exists ||
    snapshot.data().active !== true
  ) {
    throw new HttpsError(
      'permission-denied',
      'Admin access required.'
    );
  }
}

// ------------------------------------
// ACHIEVEMENT ENGINE
// ------------------------------------

// This function is internal. There is no callable endpoint
// that lets a client submit arbitrary achievement events.
//
// Metric rules:
// count = add event amount
// sum   = add event amount
// max   = retain the highest value

async function awardAchievementEvent(
  uid,
  eventName,
  payload = {}
) {
  const eventId = String(payload.eventId || '');

  if (!/^[A-Za-z0-9_-]{1,180}$/.test(eventId)) {
    throw new HttpsError(
      'invalid-argument',
      'Invalid achievement event ID.'
    );
  }

  const candidates = BASE_ACHIEVEMENTS.filter(
    (a) =>
      a.condition &&
      a.condition.event === eventName &&
      a.status === 'server_supported'
  );

  const receipt = achievementReceiptRef(uid, eventId);
  const pRef = playerRef(uid);

  const result = await db.runTransaction(
    async (transaction) => {
      const [receiptSnap, playerSnap] =
        await Promise.all([
          transaction.get(receipt),
          transaction.get(pRef)
        ]);

      if (receiptSnap.exists) {
        return {
          duplicate: true,
          unlocked: 0,
          completed: playerSnap.exists
            ? playerSnap.data().achievementsCompleted || 0
            : 0,
          level: playerSnap.exists
            ? playerSnap.data().level || 1
            : 1
        };
      }

      if (!playerSnap.exists) {
        throw new HttpsError(
          'failed-precondition',
          'Player profile is missing.'
        );
      }

      const player = playerSnap.data();

      const refs = candidates.map((a) => ({
        achievement: a,
        progressRef: achievementProgressRef(uid, a.id),
        earnedRef: playerAchievementRef(uid, a.id)
      }));

      const snapshots = await Promise.all(
        refs.flatMap((x) => [
          transaction.get(x.progressRef),
          transaction.get(x.earnedRef)
        ])
      );

      const secretRef =
        playerAchievementRef(
          uid,
          SECRET_ACHIEVEMENT.id
        );

      const secretSnap =
        await transaction.get(secretRef);

      let unlocked = 0;
      let xpReward = 0;
      let coinReward = 0;

      const progressWrites = [];

      for (let i = 0; i < refs.length; i++) {
        const item = refs[i];

        const progressSnap = snapshots[i * 2];
        const earnedSnap = snapshots[i * 2 + 1];

        if (earnedSnap.exists) {
          continue;
        }

        const condition =
          item.achievement.condition;

        const oldValue = progressSnap.exists
          ? Number(progressSnap.data().progress || 0)
          : 0;

        const amount =
          Number.isFinite(payload.amount)
            ? Math.max(0, payload.amount)
            : 1;

        const value =
          Number.isFinite(payload.value)
            ? Math.max(0, payload.value)
            : amount;

        let nextValue = oldValue;

        if (condition.metric === 'max') {
          nextValue = Math.max(oldValue, value);
        } else if (
          condition.metric === 'sum' ||
          condition.metric === 'count'
        ) {
          nextValue = oldValue + amount;
        } else {
          continue;
        }

        const isUnlocked =
          nextValue >= condition.target;

        progressWrites.push({
          ref: item.progressRef,
          achievement: item.achievement,
          progress: nextValue,
          isUnlocked,
          earnedRef: item.earnedRef
        });

        if (isUnlocked) {
          unlocked++;

          xpReward += Number(
            item.achievement.reward?.xp || 0
          );

          coinReward += Number(
            item.achievement.reward?.coins || 0
          );
        }
      }

      const oldCompleted =
        Number(player.achievementsCompleted || 0);

      const newCompleted =
        Math.min(150, oldCompleted + unlocked);

      const secretUnlocked =
        !secretSnap.exists && newCompleted >= 150;

      if (secretUnlocked) {
        coinReward += Number(
          SECRET_ACHIEVEMENT.reward?.coins || 0
        );
      }

      // All Firestore reads are complete.
      // Writes begin here.

      for (const item of progressWrites) {
        transaction.set(
          item.ref,
          {
            achievementId: item.achievement.id,
            progress: item.progress,
            target: item.achievement.condition.target,
            completed: item.isUnlocked,
            updatedAt: FieldValue.serverTimestamp()
          },
          { merge: true }
        );

        if (item.isUnlocked) {
          transaction.create(
            item.earnedRef,
            {
              achievementId: item.achievement.id,
              title: item.achievement.title,
              rarity: item.achievement.rarity,
              category: item.achievement.category,
              reward: item.achievement.reward,
              completedAt: FieldValue.serverTimestamp()
            }
          );
        }
      }

      let xpResult = {
        level: player.level || 1,
        levelsGained: 0,
        awardedXp: 0
      };

      if (
        xpReward > 0 &&
        (player.level || 1) < MAX_LEVEL
      ) {
        xpResult = grantXpInTransaction(
          transaction,
          uid,
          player,
          xpReward
        );
      }

      const actualCoins =
        grantCoinsInTransaction(player, coinReward);

      transaction.update(
        pRef,
        {
          coins: (player.coins || 0) + actualCoins,
          achievementsCompleted: newCompleted,

          secretAchievementUnlocked:
            secretUnlocked ||
            player.secretAchievementUnlocked === true,

          ...(secretUnlocked
            ? {
                title: SECRET_ACHIEVEMENT.reward.title,
                exclusiveFrame:
                  SECRET_ACHIEVEMENT.reward.exclusiveFrame
              }
            : {}),

          updatedAt: FieldValue.serverTimestamp()
        }
      );

      if (unlocked > 0 || secretUnlocked) {
        addPublicRankingWrites(
          transaction,
          uid,
          player,
          {
            level: xpResult.level,
            totalXp:
              (player.totalXp || 0) +
              (xpResult.awardedXp || 0),
            achievementsCompleted: newCompleted
          }
        );
      }

      if (secretUnlocked) {
        transaction.create(
          secretRef,
          {
            achievementId: SECRET_ACHIEVEMENT.id,
            title: SECRET_ACHIEVEMENT.title,
            rarity: 'Secret',
            reward: SECRET_ACHIEVEMENT.reward,
            completedAt: FieldValue.serverTimestamp()
          }
        );
      }

      transaction.create(
        receipt,
        {
          event: eventName,
          eventId,
          unlockedCount: unlocked,
          createdAt: FieldValue.serverTimestamp()
        }
      );

      return {
        duplicate: false,
        unlocked,
        secretUnlocked,
        achievementsCompleted: newCompleted,
        xpReward: xpResult.awardedXp || 0,
        coinReward: actualCoins,
        level: xpResult.level,
        levelsGained: xpResult.levelsGained || 0
      };
    }
  );

  if (result.duplicate) {
    return result;
  }

  if (
    result.unlocked > 0 &&
    eventName !== 'achievements_completed'
  ) {
    await awardAchievementEvent(
      uid,
      'achievements_completed',
      {
        eventId: `meta-${eventId}`,
        amount: result.unlocked,
        value: result.unlocked
      }
    );
  }

  if (
    result.levelsGained > 0 &&
    eventName !== 'player_level'
  ) {
    await awardAchievementEvent(
      uid,
      'player_level',
      {
        eventId: `level-${eventId}-${result.level}`,
        amount: 1,
        value: result.level
      }
    );
  }

  return result;
}

// ------------------------------------
// PLAYER CREATION
// ------------------------------------

exports.createPlayerProfile =
  functionsV1
    .region(REGION)
    .auth
    .user()
    .onCreate(async (user) => {
      const uid = user.uid;

      const displayName =
        String(user.displayName || 'Player')
          .trim()
          .slice(0, 24) || 'Player';

      const pRef = playerRef(uid);

      await db.runTransaction(
        async (transaction) => {
          const existing =
            await transaction.get(pRef);

          if (existing.exists) {
            return;
          }

          const player = {
            uid,
            displayName,
            avatarId: 'default',

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

            title: null,
            exclusiveFrame: null,

            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp()
          };

          transaction.create(pRef, player);

          addPublicRankingWrites(
            transaction,
            uid,
            player
          );
        }
      );

      await awardAchievementEvent(
        uid,
        'site_login',
        {
          eventId: `account-created-${uid}`,
          amount: 1,
          value: 1
        }
      );
    });

// ------------------------------------
// UPDATE PLAYER PROFILE
// ------------------------------------

exports.updatePlayerProfile =
  onCall({ region: REGION }, async (request) => {
    const uid = requireAuth(request);

    const displayName =
      String(request.data?.displayName || '').trim();

    const avatarId =
      String(request.data?.avatarId || 'default').trim();

    if (
      displayName.length < 2 ||
      displayName.length > 24
    ) {
      throw new HttpsError(
        'invalid-argument',
        'Display name must be 2–24 characters.'
      );
    }

    if (!/^(default|avatar_[0-9]{2})$/.test(avatarId)) {
      throw new HttpsError(
        'invalid-argument',
        'Invalid avatar ID.'
      );
    }

    const pRef = playerRef(uid);

    await db.runTransaction(
      async (transaction) => {
        const snapshot =
          await transaction.get(pRef);

        if (!snapshot.exists) {
          throw new HttpsError(
            'failed-precondition',
            'Player profile is missing.'
          );
        }

        const player = snapshot.data();

        transaction.update(
          pRef,
          {
            displayName,
            avatarId,
            updatedAt: FieldValue.serverTimestamp()
          }
        );

        addPublicRankingWrites(
          transaction,
          uid,
          player,
          { displayName, avatarId }
        );
      }
    );

    const suffix =
      crypto.randomBytes(6).toString('hex');

    await Promise.all([
      awardAchievementEvent(
        uid,
        'display_name_set',
        {
          eventId: `name-${suffix}`,
          amount: 1,
          value: 1
        }
      ),

      awardAchievementEvent(
        uid,
        'avatar_equipped',
        {
          eventId: `avatar-${suffix}`,
          amount: 1,
          value: 1
        }
      ),

      awardAchievementEvent(
        uid,
        'profile_completed',
        {
          eventId: `profile-${suffix}`,
          amount: 1,
          value: 1
        }
      )
    ]);

    return {
      success: true,
      displayName,
      avatarId
    };
  });

// ------------------------------------
// DAILY ATTENDANCE
// 50 coins daily + 250 on every 7th day
// ------------------------------------

exports.dailyCheckIn =
  onCall({ region: REGION }, async (request) => {
    const uid = requireAuth(request);

    const today = egyptDate();
    const pRef = playerRef(uid);

    const attendanceRef =
      db.collection('attendance')
        .doc(uid)
        .collection('days')
        .doc(today);

    const transactionRef =
      db.collection('transactions')
        .doc(uid)
        .collection('items')
        .doc(`attendance-${today}`);

    const result = await db.runTransaction(
      async (transaction) => {
        const [attendanceSnap, playerSnap] =
          await Promise.all([
            transaction.get(attendanceRef),
            transaction.get(pRef)
          ]);

        if (!playerSnap.exists) {
          throw new HttpsError(
            'failed-precondition',
            'Player profile is missing.'
          );
        }

        if (attendanceSnap.exists) {
          const previous = attendanceSnap.data();

          return {
            success: true,
            alreadyCheckedIn: true,
            streak: previous.streak,
            dailyReward: previous.dailyReward,
            weeklyReward: previous.weeklyReward,
            totalReward: previous.totalReward
          };
        }

        const player = playerSnap.data();

        const streak =
          player.lastAttendanceDay &&
          dayDifference(
            player.lastAttendanceDay,
            today
          ) === 1
            ? (player.attendanceStreak || 0) + 1
            : 1;

        const dailyReward = DAILY_COINS;

        const weeklyReward =
          streak % 7 === 0
            ? WEEKLY_STREAK_BONUS
            : 0;

        const baseReward =
          dailyReward + weeklyReward;

        const totalReward =
          grantCoinsInTransaction(
            player,
            baseReward
          );

        transaction.update(
          pRef,
          {
            coins:
              (player.coins || 0) + totalReward,

            attendanceStreak: streak,
            lastAttendanceDay: today,

            updatedAt: FieldValue.serverTimestamp()
          }
        );

        transaction.create(
          attendanceRef,
          {
            uid,
            date: today,
            streak,
            dailyReward,
            weeklyReward,
            totalReward,
            createdAt: FieldValue.serverTimestamp()
          }
        );

        transaction.create(
          transactionRef,
          {
            type: 'attendance',
            amount: totalReward,
            dailyReward,
            weeklyReward,
            createdAt: FieldValue.serverTimestamp()
          }
        );

        return {
          success: true,
          alreadyCheckedIn: false,
          streak,
          dailyReward,
          weeklyReward,
          totalReward
        };
      }
    );

    if (!result.alreadyCheckedIn) {
      await Promise.all([
        awardAchievementEvent(
          uid,
          'daily_checkin',
          {
            eventId: `checkin-${today}`,
            amount: 1,
            value: 1
          }
        ),

        awardAchievementEvent(
          uid,
          'attendance_streak',
          {
            eventId: `streak-${today}`,
            amount: 1,
            value: result.streak
          }
        ),

        awardAchievementEvent(
          uid,
          'coins_earned',
          {
            eventId: `attendance-coins-${today}`,
            amount: result.totalReward,
            value: result.totalReward
          }
        )
      ]);
    }

    return result;
  });

// ------------------------------------
// ADMIN: GRANT XP
// ------------------------------------

exports.adminGrantXp =
  onCall({ region: REGION }, async (request) => {
    const adminUid = requireAuth(request);

    await verifyAdmin(adminUid);

    const uid = String(request.data?.uid || '');

    if (!/^[A-Za-z0-9_-]{10,128}$/.test(uid)) {
      throw new HttpsError(
        'invalid-argument',
        'Invalid player UID.'
      );
    }

    const amount = safeInteger(
      request.data?.amount,
      1,
      10000,
      'XP amount'
    );

    const result = await db.runTransaction(
      async (transaction) => {
        const snapshot =
          await transaction.get(playerRef(uid));

        if (!snapshot.exists) {
          throw new HttpsError(
            'not-found',
            'Player not found.'
          );
        }

        return grantXpInTransaction(
          transaction,
          uid,
          snapshot.data(),
          amount
        );
      }
    );

    if (result.levelsGained > 0) {
      await awardAchievementEvent(
        uid,
        'player_level',
        {
          eventId:
            `admin-level-${crypto.randomBytes(8).toString('hex')}`,
          amount: 1,
          value: result.level
        }
      );
    }

    return {
      success: true,
      ...result
    };
  });

// ------------------------------------
// ACTIVATE STORED BOOSTS
// ------------------------------------

async function activateBoost(
  uid,
  boostId,
  expectedType
) {
  if (
    typeof boostId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,150}$/.test(boostId)
  ) {
    throw new HttpsError(
      'invalid-argument',
      'Invalid boost ID.'
    );
  }

  const pRef = playerRef(uid);
  const itemRef = inventoryRef(uid).doc(boostId);

  const result = await db.runTransaction(
    async (transaction) => {
      const [playerSnap, itemSnap] =
        await Promise.all([
          transaction.get(pRef),
          transaction.get(itemRef)
        ]);

      if (!playerSnap.exists || !itemSnap.exists) {
        throw new HttpsError(
          'not-found',
          'Player or boost not found.'
        );
      }

      const player = playerSnap.data();
      const item = itemSnap.data();

      if (
        item.type !== expectedType ||
        item.status !== 'stored'
      ) {
        throw new HttpsError(
          'failed-precondition',
          'This boost is not available.'
        );
      }

      const activeKey =
        expectedType === 'xp_boost'
          ? 'activeXpBoost'
          : 'activeCoinsBoost';

      if (activeBoost(player[activeKey])) {
        throw new HttpsError(
          'failed-precondition',
          'A boost of this type is already active.'
        );
      }

      const durationMinutes =
        Number(
          item.durationMinutes ||
          Number(item.durationHours || 1) * 60
        );

      if (
        !Number.isInteger(durationMinutes) ||
        durationMinutes < 1 ||
        durationMinutes > 1440
      ) {
        throw new HttpsError(
          'failed-precondition',
          'Invalid boost duration.'
        );
      }

      const now = Date.now();

      const activatedAt =
        Timestamp.fromMillis(now);

      const expiresAt =
        Timestamp.fromMillis(
          now + durationMinutes * 60000
        );

      transaction.update(
        itemRef,
        {
          status: 'used',
          activatedAt,
          expiresAt
        }
      );

      transaction.update(
        pRef,
        {
          [activeKey]: {
            multiplier: 2,
            activatedAt,
            expiresAt
          },
          updatedAt: FieldValue.serverTimestamp()
        }
      );

      return {
        success: true,
        type: expectedType,
        multiplier: 2,
        durationMinutes,
        expiresAt: expiresAt.toDate().toISOString()
      };
    }
  );

  if (expectedType === 'xp_boost') {
    await awardAchievementEvent(
      uid,
      'xp_boost_activated',
      {
        eventId: `boost-${boostId}`,
        amount: 1,
        value: 1
      }
    );
  }

  return result;
}

exports.activateXpBoost =
  onCall({ region: REGION }, async (request) => {
    const uid = requireAuth(request);

    return activateBoost(
      uid,
      request.data?.boostId,
      'xp_boost'
    );
  });

exports.activateCoinsBoost =
  onCall({ region: REGION }, async (request) => {
    const uid = requireAuth(request);

    return activateBoost(
      uid,
      request.data?.boostId,
      'coins_boost'
    );
  });

// ------------------------------------
// ADMIN: CREATE ONE-TIME REDEEM CODE
// ------------------------------------

exports.adminCreateRedeemCode =
  onCall({ region: REGION }, async (request) => {
    const adminUid = requireAuth(request);

    await verifyAdmin(adminUid);

    const type = request.data?.type;

    if (
      !['coins', 'xp_boost', 'coins_boost'].includes(type)
    ) {
      throw new HttpsError(
        'invalid-argument',
        'Invalid code type.'
      );
    }

    let reward;

    if (type === 'coins') {
      reward = {
        amount: safeInteger(
          request.data?.amount,
          1,
          5000,
          'coin amount'
        )
      };

      if (!ALLOWED_COIN_REWARDS.includes(reward.amount)) {
        throw new HttpsError(
          'invalid-argument',
          'Unsupported coin amount.'
        );
      }
    } else {
      reward = {
        multiplier: 2,
        durationHours: safeInteger(
          request.data?.durationHours,
          1,
          24,
          'boost duration'
        )
      };
    }

    const code =
      `IMG-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

    const hash =
      crypto.createHash('sha256')
        .update(code)
        .digest('hex');

    const codeRef =
      db.collection('redeemCodes').doc(hash);

    const logRef =
      db.collection('adminLogs').doc();

    await db.runTransaction(
      async (transaction) => {
        transaction.create(
          codeRef,
          {
            type,
            ...reward,
            used: false,
            usedBy: null,
            createdBy: adminUid,
            createdAt: FieldValue.serverTimestamp()
          }
        );

        transaction.create(
          logRef,
          {
            adminUid,
            action: 'create_redeem_code',
            rewardType: type,
            createdAt: FieldValue.serverTimestamp()
          }
        );
      }
    );

    return {
      success: true,
      code,
      type,
      ...reward
    };
  });

// ------------------------------------
// PLAYER: REDEEM ONE-TIME CODE
// ------------------------------------

exports.redeemStoreCode =
  onCall({ region: REGION }, async (request) => {
    const uid = requireAuth(request);
    const rawCode = request.data?.code;

    if (
      typeof rawCode !== 'string' ||
      rawCode.trim().length < 8 ||
      rawCode.trim().length > 40
    ) {
      throw new HttpsError('invalid-argument', 'Invalid code.');
    }

    const normalizedCode = rawCode.trim().toUpperCase();
    const hash = crypto.createHash('sha256')
      .update(normalizedCode)
      .digest('hex');

    const codeRef = db.collection('redeemCodes').doc(hash);
    const pRef = playerRef(uid);

    const transactionRef = db.collection('transactions')
      .doc(uid)
      .collection('items')
      .doc(`redeem-${hash}`);

    const result = await db.runTransaction(async (transaction) => {
      const [codeSnap, playerSnap] = await Promise.all([
        transaction.get(codeRef),
        transaction.get(pRef)
      ]);

      if (!codeSnap.exists) {
        throw new HttpsError('not-found', 'Code not found.');
      }

      if (!playerSnap.exists) {
        throw new HttpsError(
          'failed-precondition',
          'Player profile is missing.'
        );
      }

      const code = codeSnap.data();

      if (code.used) {
        throw new HttpsError(
          'already-exists',
          'This code has already been redeemed.'
        );
      }

      const player = playerSnap.data();
      const now = FieldValue.serverTimestamp();

      let actualAmount = null;

      if (code.type === 'coins') {
        if (!ALLOWED_COIN_REWARDS.includes(code.amount)) {
          throw new HttpsError(
            'failed-precondition',
            'Invalid code reward.'
          );
        }

        actualAmount = grantCoinsInTransaction(player, code.amount);

        transaction.update(pRef, {
          coins: (player.coins || 0) + actualAmount,
          updatedAt: now
        });

        transaction.create(transactionRef, {
          type: 'redeem_code',
          amount: actualAmount,
          createdAt: now
        });
      } else if (
        code.type === 'xp_boost' ||
        code.type === 'coins_boost'
      ) {
        if (
          code.multiplier !== 2 ||
          !Number.isInteger(code.durationHours) ||
          code.durationHours < 1 ||
          code.durationHours > 24
        ) {
          throw new HttpsError(
            'failed-precondition',
            'Invalid boost code reward.'
          );
        }

        const itemRef = inventoryRef(uid).doc(`code-${hash}`);

        transaction.create(itemRef, {
          type: code.type,
          multiplier: 2,
          durationHours: code.durationHours,
          durationMinutes: code.durationHours * 60,
          status: 'stored',
          source: 'redeem_code',
          createdAt: now
        });

        transaction.create(transactionRef, {
          type: 'redeem_code',
          rewardType: code.type,
          durationHours: code.durationHours,
          createdAt: now
        });
      } else {
        throw new HttpsError(
          'failed-precondition',
          'Unsupported code reward.'
        );
      }

      transaction.update(codeRef, {
        used: true,
        usedBy: uid,
        usedAt: now
      });

      return {
        success: true,
        rewardType: code.type,
        amount: code.type === 'coins' ? code.amount : null,
        actualAmount
      };
    });

    if (result.rewardType === 'coins') {
      await awardAchievementEvent(uid, 'coins_earned', {
        eventId: `redeem-coins-${hash}`,
        amount: result.actualAmount,
        value: result.actualAmount
      });
    }

    return result;
  });
// ------------------------------------
// GET ACHIEVEMENT CATALOG
// ------------------------------------

exports.getAchievementCatalog =
  onCall({ region: REGION }, async (request) => {
    requireAuth(request);

    return {
      schemaVersion: catalog.schemaVersion,
      baseAchievementCount: catalog.baseAchievementCount,
      secretAchievementCount: catalog.secretAchievementCount,
      rarityDistribution: catalog.rarityDistribution,

      achievements: BASE_ACHIEVEMENTS.map((a) => ({
        id: a.id,
        title: a.title,
        description: a.description,
        category: a.category,
        rarity: a.rarity,
        scope: a.scope,
        condition: a.condition,
        reward: a.reward,
        status: a.status
      }))
    };
  });
