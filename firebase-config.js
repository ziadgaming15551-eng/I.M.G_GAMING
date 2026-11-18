/* I.M.G GAMING - Firebase Configuration */

const firebaseConfig = {
  apiKey: "AIzaSyDkkNRFc3_lwbtvBDe0LxSFqBTqVe_-PXM",
  authDomain: "img-2a473.firebaseapp.com",
  projectId: "img-2a473",
  storageBucket: "img-2a473.firebasestorage.app",
  messagingSenderId: "534617572811",
  appId: "1:534617572811:web:93d389efe30ca9c8c3a24e"
};

if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

const auth = firebase.auth();
const db = firebase.firestore();

auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL)
  .catch((error) => {
    console.error("Auth persistence error:", error);
  });
