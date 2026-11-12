const { onUserCreated } = require("firebase-functions/v2/identity");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const {
  getFirestore,
  FieldValue
} = require("firebase-admin/firestore");

initializeApp();

const db = getFirestore();
const REGION = "europe-west1";
const TIME_ZONE = "Africa/Cairo";

// Get the current date in Egypt.
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

// Create a player's private and public profiles automatically.
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
      const playerSnapshot = await transaction.get(playerRef);

      if (playerSnapshot.exists) return;

      const now = FieldValue.serverTimestamp();

      transaction.set(playerRef, {
        uid,
        displayName,
        level: 1,
        xp: 0,
        coins: 0,
        achievementsCompleted: 0,
        attendanceStreak: 0,
        lastAttendanceDay: null,
        createdAt: now,
        updatedAt: now
      });

      transaction.set(publicRef, {
        uid,
        displayName,
        avatarId: "default",
        level: 1,
        achievementsCompleted: 0,
        createdAt: now,
        updatedAt: now
      });
    });
  }
);

// Daily attendance: 50 coins.
// Every 7 consecutive attendance days: an extra 500 coins.
exports.dailyCheckIn = onCall(
  { region: REGION },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "You must sign in first."
      );
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
          weeklyReward: 0,
          message: "Attendance already recorded today."
        };
      }

      const player = playerSnapshot.exists
        ? playerSnapshot.data()
        : {
            uid,
            displayName: "Player",
            level: 1,
            xp: 0,
            coins: 0,
            achievementsCompleted: 0,
            attendanceStreak: 0,
            lastAttendanceDay: null
          };

      const previousDay = player.lastAttendanceDay;
      let streak = 1;

      if (previousDay && dayDifference(previousDay, today) === 1) {
        streak = (player.attendanceStreak || 0) + 1;
      }

      const dailyReward = 50;
      const weeklyReward = streak % 7 === 0 ? 500 : 0;
      const totalReward = dailyReward + weeklyReward;
      const newCoins = (player.coins || 0) + totalReward;

      const now = FieldValue.serverTimestamp();

      const playerUpdates = {
        coins: newCoins,
        attendanceStreak: streak,
        lastAttendanceDay: today,
        updatedAt: now
      };

      if (playerSnapshot.exists) {
        transaction.update(playerRef, playerUpdates);
      } else {
        transaction.set(playerRef, {
          ...player,
          ...playerUpdates,
          createdAt: now
        });
      }

      transaction.set(attendanceRef, {
        uid,
        date: today,
        streak,
        dailyReward,
        weeklyReward,
        totalReward,
        createdAt: now
      });

      transaction.set(transactionRef, {
        type: "attendance",
        dailyReward,
        weeklyReward,
        amount: totalReward,
        createdAt: now
      });

      return {
        success: true,
        alreadyCheckedIn: false,
        streak,
        dailyReward,
        weeklyReward,
        totalReward,
        newCoins
      };
    });
  }
);
