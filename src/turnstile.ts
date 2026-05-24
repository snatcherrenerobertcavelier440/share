export async function verifyTurnstile(token: string | undefined, remoteip: string | undefined, secret: string | undefined): Promise<boolean> {
  if (!secret || !token) return false;
  const body = new FormData();
  body.set("secret", secret);
  body.set("response", token);
  if (remoteip) body.set("remoteip", remoteip);
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
  if (!response.ok) return false;
  const result = await response.json<{ success?: boolean }>();
  return result.success === true;
}
