import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { auth, authReady } from "./firebase-config.js";

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
      await authReady;
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