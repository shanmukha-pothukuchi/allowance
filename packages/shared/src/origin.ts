/** "http://localhost:4021/api/weather?x=1" -> "http://localhost:4021" */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}
