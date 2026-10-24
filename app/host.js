/**
 * Host platform facts for the shared app shell.
 *
 * The same bundle runs in the Tauri webview and in the local browser service,
 * so OS detection must work in both: Deno exposes `Deno.build.os`, and a
 * WebView falls back to the user agent. All user-facing platform copy (where
 * API Keys are stored, what the file manager is called) derives from here so
 * the wording can never drift between routes or shells.
 */

export function hostOsFamily() {
  try {
    if (typeof Deno !== "undefined" && Deno.build && typeof Deno.build.os === "string") {
      return Deno.build.os; // "windows" | "darwin" | "linux"
    }
  } catch (_) {
    // Not a Deno runtime; fall through to the user agent.
  }
  const ua = (typeof navigator !== "undefined" && navigator && navigator.userAgent) || "";
  if (/Windows/i.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/i.test(ua)) return "darwin";
  return "unknown";
}

/** Where the running shell keeps API Keys. Mirrors src/service/security.ts. */
export function appCredentialStoreLabel(nativeShell) {
  if (hostOsFamily() === "windows") {
    return nativeShell ? "Windows 凭据管理器" : "Windows 凭据保护存储（本机浏览器服务）";
  }
  return nativeShell ? "macOS 系统钥匙串" : "macOS 系统钥匙串（本机浏览器服务）";
}

/** Shell-neutral name of the platform credential store, for generic copy. */
export function appCredentialStoreName() {
  return hostOsFamily() === "windows" ? "Windows 凭据保护存储" : "macOS 系统钥匙串";
}

/** Platform name of the file manager used for "reveal export". */
export function fileManagerLabel() {
  return hostOsFamily() === "windows" ? "资源管理器" : "Finder";
}

/** Desktop shells (macOS and Windows) support ChatGPT subscription sign-in. */
export function desktopShellLabel() {
  return "桌面版（macOS / Windows）";
}
