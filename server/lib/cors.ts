export function isAllowedCorsOrigin(
  origin: string,
  allowedOrigins: string[],
  allowLocalDevelopmentOrigins: boolean
): boolean {
  if (allowedOrigins.includes(origin)) return true;
  if (!allowLocalDevelopmentOrigins) return false;

  try {
    const parsedOrigin = new URL(origin);
    return parsedOrigin.origin === origin
      && (parsedOrigin.protocol === "http:" || parsedOrigin.protocol === "https:")
      && (parsedOrigin.hostname === "localhost" || parsedOrigin.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}