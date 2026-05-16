export async function ensureLocalSession() {
  const response = await fetch("/api/auth/local", {
    method: "GET",
    credentials: "same-origin",
  });

  if (!response.ok) {
    throw new Error("Failed to initialize local authenticated workspace");
  }
}
