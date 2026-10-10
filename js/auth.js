(() => {
  const form = document.getElementById("auth-form");
  const intro = document.getElementById("auth-intro");
  const username = document.getElementById("auth-username");
  const password = document.getElementById("auth-password");
  const submit = document.getElementById("auth-submit");
  const error = document.getElementById("auth-error");
  let setupMode = false;

  fetch("/api/auth/status", { cache: "no-store" })
    .then((r) => r.json())
    .then((state) => {
      if (state.authenticated) { location.replace("/"); return; }
      setupMode = !state.configured;
      if (setupMode) {
        intro.textContent = "Create the first local account to finish setup.";
        submit.textContent = "Create account";
        password.autocomplete = "new-password";
      }
      submit.disabled = false;
    })
    .catch(() => {
      error.textContent = "Could not reach the local AzollaSense server. Refresh to try again.";
      submit.disabled = true;
    });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    submit.disabled = true;
    try {
      const response = await fetch(setupMode ? "/api/auth/setup" : "/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.value.trim(), password: password.value })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Unable to sign in.");
      location.replace("/");
    } catch (err) {
      error.textContent = err.message || "Could not reach the local server.";
    } finally {
      submit.disabled = false;
    }
  });
})();
