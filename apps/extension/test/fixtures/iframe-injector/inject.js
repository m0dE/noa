// Appends this extension's own page as an iframe, like Streak does inside Gmail.
// Test pages control it with <meta name="inject-delay" content="ms"> and <meta name="no-inject">.
(() => {
  if (document.querySelector('meta[name="no-inject"]')) return;
  const meta = document.querySelector('meta[name="inject-delay"]');
  const delay = meta ? Number(meta.content) : 0;
  const add = () => {
    const f = document.createElement("iframe");
    f.id = "foreign-extension-frame";
    f.src = chrome.runtime.getURL("frame.html");
    f.style.cssText = "width:300px;height:80px;border:1px solid red";
    document.body.appendChild(f);
  };
  if (delay > 0) setTimeout(add, delay);
  else add();
})();
