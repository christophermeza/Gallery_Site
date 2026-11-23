import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  setPersistence,
  browserSessionPersistence
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAdJOUeCtXQC5k5qabCQZoQ8hoXvLNWJq0",
  authDomain: "gallery-site-d188d.firebaseapp.com",
  projectId: "gallery-site-d188d",
  storageBucket: "gallery-site-d188d.firebasestorage.app",
  messagingSenderId: "154184726328",
  appId: "1:154184726328:web:97d7062afb03ef792eb3cd",
  measurementId: "G-4EXWDTN96L"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

export const authReady = setPersistence(auth, browserSessionPersistence).catch((err) => {
  console.warn("Auth persistence fallback:", err.message);
});