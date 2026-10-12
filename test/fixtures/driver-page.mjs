// The page the driver e2e scripts act on: a link, a counter button, a text input in a form, a
// contenteditable editor, a hidden file input, a signup form (text field, dropdown, checkbox) and a
// tall body to scroll, each reporting what happened to it in the page's text (Count, trusted,
// Submitted, Files, Last key, Country, ScrollY).

/** The page's HTML. `head`: more HTML for <head> (e.g. the iframe-injector's meta tags). */
export const driverPage = ({ title, heading, head = "" }) => `<!doctype html><html><head><title>${title}</title>${head}
<style>body{font-family:sans-serif} .tall{height:3000px} #gone{display:none}</style></head><body>
<h1>${heading}</h1>
<a href="/other" data-testid="other-link">Other page</a>
<button id="inc" data-testid="incButton" onclick="document.getElementById('count').textContent = String(++window.clicks); document.getElementById('trusted').textContent = String(event.isTrusted)">Increment</button>
<p>Count: <span id="count">0</span> trusted: <span id="trusted">-</span></p>
<form onsubmit="event.preventDefault(); document.getElementById('submitted').textContent = document.getElementById('name').value">
<label for="name">Your name</label><input id="name" type="text"></form>
<p>Submitted: <span id="submitted">none</span></p>
<div id="editor" role="textbox" contenteditable="true" aria-label="Compose text" style="border:1px solid #999;min-height:40px"></div>
<input type="file" id="file" style="display:none" onchange="document.getElementById('files').textContent = [...this.files].map(f => f.name + ':' + f.size).join(',')">
<p>Files: <span id="files">none</span></p>
<p>Last key: <span id="lastkey">none</span></p>
<form id="signup" onsubmit="event.preventDefault()">
<label>Job title<input type="text" name="jobTitle"></label>
<label>Country<select name="country" required onchange="document.getElementById('country').textContent = this.value"><option value="">Select…</option><option value="uk">United Kingdom</option><option value="us">United States</option></select></label>
<label><input type="checkbox" name="terms" value="yes" required> I agree to the terms</label>
</form>
<p>Country: <span id="country">none</span></p>
<p>ScrollY: <span id="scrolly">0</span></p>
<button id="gone">Invisible button</button>
<input type="hidden" name="secret" value="x">
<div class="tall"></div>
<script>
window.clicks = 0;
document.addEventListener('keydown', e => { document.getElementById('lastkey').textContent = (e.ctrlKey ? 'Control+' : '') + e.key; });
addEventListener('scroll', () => { document.getElementById('scrolly').textContent = String(Math.round(scrollY)); });
</script></body></html>`;

/** Where the page's link goes. */
export const OTHER_PAGE = "<title>Other</title><p>other page</p>";

/** The index of the first element of a read_page snapshot that matches `pred`. */
export function findIndex(snap, pred) {
  const el = snap.elements.find(pred);
  if (!el) throw new Error(`element not found in ${JSON.stringify(snap.elements)}`);
  return el.index;
}

/**
 * Fills the signup form through the driver the way act does, for both drivers (debugger and
 * fallback): a dropdown chosen by its label, a checkbox set twice (still checked), a field typed
 * twice (replaced, not appended), and a dropdown right after a text field (nothing leaks into the
 * field). `call(method, params)` calls a browser.* method. Returns a summary.
 */
export async function fillSignupForm(call, assert) {
  let snap = await call("readPage");
  const job = findIndex(snap, (e) => e.name === "Job title");
  const country = findIndex(snap, (e) => e.name === "Country");
  const terms = findIndex(snap, (e) => e.name === "I agree to the terms");
  assert.deepEqual(snap.elements[country].options, ["United Kingdom", "United States"]);
  assert.equal(snap.elements[terms].checked, false);
  await call("type", { index: job, text: "Head of Research" });
  assert.deepEqual(await call("type", { index: country, text: "united kingdom" }), { ok: true, selected: "United Kingdom" });
  await call("type", { index: job, text: "Head of Research" });
  assert.deepEqual(await call("click", { index: terms, checked: true }), { ok: true, checked: true });
  assert.deepEqual(await call("click", { index: terms, checked: true }), { ok: true, checked: true });
  await assert.rejects(call("type", { index: terms, text: "yes" }), /set it with checked/);
  snap = await call("readPage");
  assert.equal(snap.elements.find((e) => e.name === "Job title").value, "Head of Research");
  assert.equal(snap.elements.find((e) => e.name === "Country").value, "United Kingdom");
  assert.equal(snap.elements.find((e) => e.name === "I agree to the terms").checked, true);
  assert.match(snap.text, /Country: uk/);
  return "dropdown by label, checkbox set twice (checked), field retyped (replaced), nothing leaked";
}
