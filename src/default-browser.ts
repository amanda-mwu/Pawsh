export function browserLaunchCommand(
  url: string,
  platform: NodeJS.Platform = process.platform
): { command: string; args: string[] } {
  if (platform === "win32") return { command: "cmd.exe", args: ["/d", "/s", "/c", "start", "", url] };
  if (platform === "darwin") return { command: "open", args: [url] };
  return { command: "xdg-open", args: [url] };
}
