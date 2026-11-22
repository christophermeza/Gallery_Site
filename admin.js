import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  setPersistence,
  browserSessionPersistence,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyAdJOUeCtXQC5k5qabCQZoQ8hoXvLNWJq0",
  authDomain: "gallery-site-d188d.firebaseapp.com",
  projectId: "gallery-site-d188d",
  storageBucket: "gallery-site-d188d.firebasestorage.app",
  messagingSenderId: "154184726328",
  appId: "1:154184726328:web:97d7062afb03ef792eb3cd",
  measurementId: "G-4EXWDTN96L"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

setPersistence(auth, browserSessionPersistence).catch((err) => {
  console.warn("Auth persistence fallback:", err.message);
});

const authSection = document.getElementById("auth-section");
const workspaceSection = document.getElementById("workspace-section");
const loginForm = document.getElementById("login-form");
const authStatus = document.getElementById("auth-status");
const signOutBtn = document.getElementById("sign-out-btn");

onAuthStateChanged(auth, (user) => {
  if (!authSection || !workspaceSection) return;
  if (user) {
    authSection.hidden = true;
    workspaceSection.hidden = false;
  } else {
    authSection.hidden = false;
    workspaceSection.hidden = true;
  }
});

if (loginForm) {
  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (authStatus) authStatus.textContent = "Signing in...";
    const emailEl = document.getElementById("admin-email");
    const passwordEl = document.getElementById("admin-password");
    if (!emailEl || !passwordEl) return;

    try {
      await setPersistence(auth, browserSessionPersistence);
      await signInWithEmailAndPassword(auth, emailEl.value.trim(), passwordEl.value);
      if (authStatus) authStatus.textContent = "";
      loginForm.reset();
    } catch (err) {
      if (authStatus) authStatus.textContent = `Sign-in failed: ${err.message}`;
    }
  });
}

if (signOutBtn) {
  signOutBtn.addEventListener("click", async () => {
    await signOut(auth);
  });
}