// The page of test/e2e/shifting-select-live.mjs: a DNS records list whose "Add record" dialog picks the record type
// with Cloudflare's own Select (@cloudflare/kumo, on Base UI), as on dash.cloudflare.com. Built by that script.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Select } from "@cloudflare/kumo/components/select";
import { Dialog, DialogRoot, DialogTitle } from "@cloudflare/kumo/components/dialog";
const TYPES = ["A","AAAA","CAA","CERT","CNAME","DNSKEY","DS","HTTPS","LOC","MX","NAPTR","NS","OPENPGPKEY","PTR","SMIMEA","SRV","SSHFP","SVCB","TLSA","TXT","URI"];
function App() {
  const [records, setRecords] = useState([]);
  const [open, setOpen] = useState(false);
  const [type, setType] = useState("A");
  const [name, setName] = useState(""); const [content, setContent] = useState(""); const [priority, setPriority] = useState("");
  const save = async () => {
    const r = { type, name, content, ...(type === "MX" ? { priority } : {}) };
    await fetch("/submitted", { method: "POST", body: JSON.stringify(r) });
    setRecords((x) => [...x, r]); setOpen(false); setType("A"); setName(""); setContent(""); setPriority("");
  };
  return (
    <div style={{ padding: 24, fontFamily: "sans-serif" }}>
      <h1>DNS records · example-shop.com</h1>
      <button onClick={() => setOpen(true)}>Add record</button>
      <table><thead><tr><th>Type</th><th>Name</th><th>Content</th><th>Priority</th></tr></thead>
        <tbody>{records.map((r, i) => <tr key={i}><td>{r.type}</td><td>{r.name}</td><td>{r.content}</td><td>{r.priority ?? ""}</td></tr>)}</tbody></table>
      {/* As in the reporter's page: a records list behind the dialog long enough to scroll, with more controls than
          read_page lists (300); there the dropdown's options were numbered from 285. */}
      {Array.from({ length: 50 }, (_, i) => (
        <div key={i}>
          <input type="checkbox" aria-label={"Select record www" + i} /> www{i}.example-shop.com A 192.0.2.{i} <a href={"#r" + i}>details</a> <button>Edit</button> <button>Delete</button>{" "}
          <select aria-label="TTL"><option>Auto</option><option>1 min</option></select> <input aria-label={"Comment on www" + i} /> <button>Proxy</button>
        </div>
      ))}
      <DialogRoot open={open} onOpenChange={setOpen}>
        <Dialog>
          <DialogTitle>Add record</DialogTitle>
          <div style={{ display: "flex", gap: 12, alignItems: "end", flexWrap: "wrap" }}>
            <Select label="Type" value={type} onValueChange={(v) => setType(v)} items={Object.fromEntries(TYPES.map((t) => [t, t]))}>
              {TYPES.map((t) => <Select.Option key={t} value={t}>{t}</Select.Option>)}
            </Select>
            <label>Name <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Use @ for root" /></label>
            <label>{type === "MX" ? "Mail server" : type === "CNAME" ? "Target" : "Content"} <input value={content} onChange={(e) => setContent(e.target.value)} /></label>
            {type === "MX" && <label>Priority <input value={priority} onChange={(e) => setPriority(e.target.value)} /></label>}
          </div>
          <div style={{ marginTop: 16 }}><button onClick={() => setOpen(false)}>Cancel</button> <button onClick={save}>Save</button></div>
        </Dialog>
      </DialogRoot>
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App />);
