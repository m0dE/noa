/**
 * A real X post page as the extension read it (the user's trace, Sep 28: @arrrfun's post 2104609720988299527,
 * the agent's read_page right after it opened the page). X showed its frame only: the post's own article was not
 * drawn, so the post text was nowhere in the page's text or elements, only in the tab's title. Every read of the
 * post verification in that trace had the same shape (22 elements, 334 characters of names and texts).
 */
import type { PageSnapshot } from "@noa/shared";

export const ARRR_POST_URL = "https://x.com/arrrfun/status/2104609720988299527";

/** What the agent typed into X's composer (the act step's text, word for word). */
export const ARRR_TYPED =
  "100GB/month free. Zero servers to babysit.\n\nARRR spreads the load across a mesh, so your multiplayer prototype can grow without your budget walking the plank. ☠️\n\nStart building at arrr.fun";

/** The tab's title once X has the post (its links as t.co, its line breaks as spaces). */
export const ARRR_POST_TITLE =
  'ARRR on X: "100GB/month free. Zero servers to babysit. ARRR spreads the load across a mesh, so your multiplayer prototype can grow without your budget walking the plank. ☠️ Start building at https://t.co/INFj4ULZ2I" / X';

/** X's frame of a post page, without the post drawn in it. */
export function xStatusShell(title: string): PageSnapshot {
  return {
    url: ARRR_POST_URL,
    title,
    text: "To view keyboard shortcuts, press question mark\nARRR\n@arrrfun",
    truncated: false,
    elements: [
      { index: 0, tag: "a", role: "link", name: "View keyboard shortcuts", inViewport: true, href: "https://x.com/i/keyboard_shortcuts" },
      { index: 1, tag: "button", role: "button", name: "Grok", inViewport: true, testId: "GrokDrawerHeader" },
      { index: 2, tag: "button", role: "button", name: "Chat", inViewport: true, testId: "chat-drawer-main" },
      { index: 3, tag: "button", role: "button", name: "Skip to home timeline", inViewport: true },
      { index: 4, tag: "button", role: "button", name: "Skip to trending", inViewport: true },
      { index: 5, tag: "a", role: "link", name: "X", inViewport: true, href: "https://x.com/home" },
      { index: 6, tag: "a", role: "link", name: "Home", inViewport: true, href: "https://x.com/home", testId: "AppTabBar_Home_Link" },
      { index: 7, tag: "a", role: "link", name: "Search and explore", inViewport: true, text: "Explore", href: "https://x.com/explore", testId: "AppTabBar_Explore_Link" },
      { index: 8, tag: "a", role: "link", name: "Notifications", inViewport: true, href: "https://x.com/notifications", testId: "AppTabBar_Notifications_Link" },
      { index: 9, tag: "a", role: "link", name: "Follow", inViewport: true, href: "https://x.com/i/connect_people", testId: "AppTabBar_Follow_Link" },
      { index: 10, tag: "a", role: "link", name: "Direct Messages", inViewport: true, text: "Chat", href: "https://x.com/i/chat", testId: "AppTabBar_DirectMessage_Link" },
      { index: 11, tag: "a", role: "link", name: "Grok", inViewport: true, href: "https://x.com/i/grok" },
      { index: 12, tag: "a", role: "link", name: "History", inViewport: true, href: "https://x.com/i/history" },
      { index: 13, tag: "a", role: "link", name: "Creator Studio", inViewport: true, href: "https://x.com/i/jf/creators/studio" },
      { index: 14, tag: "a", role: "link", name: "Premium", inViewport: true, href: "https://x.com/i/premium_sign_up", testId: "premium-signup-tab" },
      { index: 15, tag: "a", role: "link", name: "Profile", inViewport: true, href: "https://x.com/arrrfun", testId: "AppTabBar_Profile_Link" },
      { index: 16, tag: "button", role: "button", name: "More menu items", inViewport: true, text: "More", testId: "AppTabBar_More_Menu" },
      { index: 17, tag: "a", role: "link", name: "Post", inViewport: true, href: "https://x.com/compose/post", testId: "SideNav_NewTweet_Button" },
      { index: 18, tag: "button", role: "button", name: "Account menu", inViewport: true, text: "ARRR @arrrfun", testId: "SideNav_AccountSwitcher_Button" },
      { index: 19, tag: "div", role: "generic", name: "Home timeline", inViewport: true, text: "Post See new posts" },
      { index: 20, tag: "button", role: "button", name: "Back", inViewport: true, testId: "app-bar-back" },
      { index: 21, tag: "button", role: "button", name: "New posts are available. Push the period key to go to the them.", inViewport: true, text: "See new posts" },
    ],
  };
}
