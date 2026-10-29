"use strict";

// Dependency-free local homepage research endpoint. It binds only to loopback.
const http = require("node:http");
const https = require("node:https");
const dns = require("node:dns").promises;
const net = require("node:net");
const { URL } = require("node:url");

const HOST = "127.0.0.1";
const PORT = Number(process.env.PROSPECT_RESEARCH_PORT || 8787);
const USER_AGENT = "LocalSEOProspectResearch/1.0 (homepage evidence preview)";
const MAX_HTML_BYTES = 1024 * 1024;
const MAX_ROBOTS_BYTES = 128 * 1024;
const REQUEST_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 4;
const MAX_POST_BYTES = 8192;
const MAX_REQUESTS_PER_MINUTE = 20;
const rateWindow = new Map();

class ResearchError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function inV4Range(address, cidr) {
  const [network, bitsText] = cidr.split("/");
  const toNumber = (value) => value.split(".").reduce((n, part) => ((n << 8) | Number(part)) >>> 0, 0);
  const bits = Number(bitsText);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((toNumber(address) & mask) >>> 0) === ((toNumber(network) & mask) >>> 0);
}

const NON_PUBLIC_V4 = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
  "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16",
  "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4"
];

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return !NON_PUBLIC_V4.some((range) => inV4Range(address, range));
  if (family !== 6) return false;
  const lower = address.toLowerCase();
  // Only global unicast IPv6 is eligible; block mapped IPv4 and documentation space too.
  if (!lower.startsWith("2") && !lower.startsWith("3")) return false;
  if (lower.startsWith("2001:db8:")) return false;
  return true;
}

function validateUrl(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 2048) {
    throw new ResearchError(400, "Enter a valid public website URL (maximum 2,048 characters).", "invalid_url");
  }
  let parsed;
  try { parsed = new URL(value); } catch (_) {
    throw new ResearchError(400, "Enter a complete website URL beginning with http:// or https://.", "invalid_url");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new ResearchError(400, "Only public http:// or https:// website URLs without credentials are accepted.", "invalid_url");
  }
  parsed.hash = "";
  if (parsed.port && parsed.port !== (parsed.protocol === "https:" ? "443" : "80")) {
    throw new ResearchError(400, "Custom ports are not allowed. Use the website's standard HTTP or HTTPS address.", "invalid_url");
  }
  if (!parsed.hostname || parsed.hostname.includes("%")) {
    throw new ResearchError(400, "That website address is not allowed.", "invalid_url");
  }
  const host = parsed.hostname.startsWith("[") ? parsed.hostname.slice(1, -1) : parsed.hostname;
  const normalizedHost = host.toLowerCase().replace(/\.$/, "");
  if (["localhost", "local", "internal"].some((suffix) => normalizedHost === suffix || normalizedHost.endsWith("." + suffix))) {
    throw new ResearchError(400, "Local and internal hostnames cannot be researched.", "blocked_destination");
  }
  if (net.isIP(host) && !isPublicAddress(host)) {
    throw new ResearchError(400, "Local, private, and reserved IP addresses cannot be researched.", "blocked_destination");
  }
  return parsed;
}

async function resolvePublicHost(hostname) {
  const unwrapped = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  if (net.isIP(unwrapped)) {
    if (!isPublicAddress(unwrapped)) throw new ResearchError(400, "Local, private, and reserved IP addresses cannot be researched.", "blocked_destination");
    return [{ address: unwrapped, family: net.isIP(unwrapped) }];
  }
  let answers;
  try { answers = await dns.lookup(unwrapped, { all: true, verbatim: true }); } catch (_) {
    throw new ResearchError(502, "The website address could not be resolved.", "dns_failure");
  }
  if (!answers.length || answers.some((answer) => !isPublicAddress(answer.address))) {
    throw new ResearchError(400, "The website resolves to a local, private, or reserved address and was blocked.", "blocked_destination");
  }
  return answers;
}

function requestOnce(parsed, addresses, byteLimit) {
  return new Promise((resolve, reject) => {
    const transport = parsed.protocol === "https:" ? https : http;
    const selected = addresses[0];
    const options = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      method: "GET",
      path: parsed.pathname + parsed.search,
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,text/plain;q=0.9,*/*;q=0.1", "Accept-Encoding": "identity", Connection: "close" },
      timeout: REQUEST_TIMEOUT_MS,
      // Pin the socket lookup to the public address already validated above.
      lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family)
    };
    if (parsed.protocol === "https:" && !net.isIP(parsed.hostname.replace(/^\[|\]$/g, ""))) {
      options.servername = parsed.hostname.replace(/^\[|\]$/g, "");
    }
    const request = transport.request(options, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        try {
          size = appendLimitedChunk(chunks, size, chunk, byteLimit);
        } catch (error) {
          request.destroy(new ResearchError(413, "The page is larger than the 1 MB preview limit.", "response_too_large"));
          return;
        }
      });
      response.on("end", () => resolve({
        status: response.statusCode || 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
        location: response.headers.location || ""
      }));
      response.on("aborted", () => reject(new ResearchError(502, "The website ended its response before the page was complete.", "incomplete_response")));
    });
    request.on("timeout", () => request.destroy(new ResearchError(504, "The website took too long to respond.", "timeout")));
    request.on("error", (error) => reject(error instanceof ResearchError ? error : new ResearchError(502, "The website could not be retrieved.", "fetch_failure")));
    request.end();
  });
}

function appendLimitedChunk(chunks, currentSize, chunk, limit) {
  const nextSize = currentSize + chunk.length;
  if (nextSize > limit) throw new ResearchError(413, "The page is larger than the 1 MB preview limit.", "response_too_large");
  chunks.push(chunk);
  return nextSize;
}

async function fetchPublic(value, options = {}) {
  let current = validateUrl(value);
  const byteLimit = options.byteLimit || MAX_HTML_BYTES;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const host = current.hostname.startsWith("[") ? current.hostname.slice(1, -1) : current.hostname;
    const addresses = await (options.resolveHost || resolvePublicHost)(host);
    const response = await (options.requestOnce || requestOnce)(current, addresses, byteLimit);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (options.rejectRedirects) throw new ResearchError(403, "The robots.txt location redirected, so access could not be confirmed safely.", "robots_redirect");
      if (!response.location || redirects === MAX_REDIRECTS) {
        throw new ResearchError(502, "The website redirected too many times or gave an invalid redirect.", "redirect_failure");
      }
      let next;
      try { next = validateUrl(new URL(response.location, current).href); } catch (error) {
        if (error instanceof ResearchError) throw new ResearchError(403, "A redirect to a prohibited destination was blocked.", "unsafe_redirect");
        throw new ResearchError(502, "The website gave an invalid redirect.", "redirect_failure");
      }
      if (options.beforeRedirect) await options.beforeRedirect(next);
      current = next;
      continue;
    }
    return { ...response, finalUrl: current.href };
  }
  throw new ResearchError(502, "The website redirected too many times.", "redirect_failure");
}

function parseRobots(text) {
  const groups = [];
  let group = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === "user-agent") {
      if (!group || group.hasRules) {
        group = { agents: [], rules: [], hasRules: false };
        groups.push(group);
      }
      group.agents.push(value.toLowerCase());
    } else if (group && ["allow", "disallow"].includes(name)) {
      group.hasRules = true;
      if (value) group.rules.push({ allow: name === "allow", path: value });
    }
  }
  return groups;
}

function robotsAllows(robotsText, targetUrl) {
  const groups = parseRobots(robotsText);
  let bestSpecificity = -1;
  let selected = [];
  for (const group of groups) {
    const specificity = Math.max(-1, ...group.agents.filter((agent) => agent !== "*" && USER_AGENT.toLowerCase().startsWith(agent)).map((agent) => agent.length));
    if (specificity > bestSpecificity) {
      bestSpecificity = specificity;
      selected = group.rules;
    } else if (specificity === bestSpecificity) {
      selected = selected.concat(group.rules);
    }
  }
  if (bestSpecificity < 0) selected = groups.filter((item) => item.agents.includes("*")).flatMap((item) => item.rules);
  const parsed = new URL(targetUrl);
  const path = parsed.pathname + parsed.search;
  let matched = null;
  for (const rule of selected) {
    let pattern = rule.path;
    const endAnchored = pattern.endsWith("$");
    if (endAnchored) pattern = pattern.slice(0, -1);
    const escaped = pattern.split("*").map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")).join(".*");
    const regex = new RegExp("^" + escaped + (endAnchored ? "$" : ""));
    if (regex.test(path) && (!matched || rule.path.length > matched.path.length || (rule.path.length === matched.path.length && rule.allow))) matched = rule;
  }
  return !matched || matched.allow;
}

async function checkRobots(targetUrl) {
  const target = new URL(targetUrl);
  const robotsUrl = new URL("/robots.txt", target.origin);
  let response;
  try { response = await fetchPublic(robotsUrl.href, { byteLimit: MAX_ROBOTS_BYTES, rejectRedirects: true }); } catch (_) {
    throw new ResearchError(403, "Access could not be confirmed safely because robots.txt could not be checked. No page content was fetched.", "robots_unknown");
  }
  if (response.status === 404 || response.status === 410) return;
  if (response.status !== 200) {
    throw new ResearchError(403, "Access could not be confirmed safely from robots.txt, so no page content was fetched.", "robots_unknown");
  }
  const robotsText = response.body.toString("utf8");
  if (!robotsAllows(robotsText, targetUrl)) {
    throw new ResearchError(403, "The website's robots.txt does not allow this homepage check.", "robots_disallowed");
  }
}

async function researchHomepage(value) {
  const inputUrl = validateUrl(value);
  await checkRobots(inputUrl.href);
  const page = await fetchPublic(inputUrl.href, { byteLimit: MAX_HTML_BYTES, beforeRedirect: checkRobots });
  if (page.status === 401 || page.status === 403) throw new ResearchError(403, "The website denied access to its homepage.", "site_blocked");
  if (page.status < 200 || page.status >= 300) throw new ResearchError(502, "The website returned an error instead of a homepage.", "http_failure");
  const contentType = String(page.headers["content-type"] || "").toLowerCase();
  const contentEncoding = String(page.headers["content-encoding"] || "").toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    throw new ResearchError(415, "The website used a compressed response this preview cannot safely read.", "unsupported_encoding");
  }
  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
    throw new ResearchError(415, "The website did not return an HTML homepage.", "not_html");
  }
  const parsed = parseHtml(page.body.toString("utf8"));
  const empty = !parsed.title && !parsed.metaDescription && !parsed.headings.length && !parsed.excerpts.length;
  return { sourceUrl: page.finalUrl, ...parsed, empty };
}

function decodeEntities(value) {
  const named = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
  return value.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|[a-z]+);/gi, (whole, code) => {
    if (code[0] === "#") {
      const hex = code[1].toLowerCase() === "x";
      const number = Number.parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(number) || number < 0 || number > 0x10ffff || (number >= 0xd800 && number <= 0xdfff)) return "\uFFFD";
      try { return String.fromCodePoint(number); } catch (_) { return "\uFFFD"; }
    }
    return Object.prototype.hasOwnProperty.call(named, code.toLowerCase()) ? named[code.toLowerCase()] : whole;
  });
}

function attributesOf(raw) {
  const attributes = Object.create(null);
  const body = raw.replace(/^\s*[a-zA-Z][\w:-]*/, "").replace(/\/\s*$/, "");
  const regex = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match;
  while ((match = regex.exec(body))) attributes[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  return attributes;
}

function parseHtml(html) {
  const output = { title: "", metaDescription: "", headings: [], excerpts: [] };
  const tokens = /<!--[\s\S]*?-->|<![^>]*>|<\/?[a-zA-Z][\w:-]*\b[^>]*>|[^<]+|</g;
  const stack = [];
  let activeTitle = false;
  let titleText = "";
  let heading = null;
  let paragraph = null;
  const hidden = () => stack.some((tag) => ["script", "style", "noscript", "svg", "template", "head"].includes(tag));
  const clean = (value) => value.replace(/\s+/g, " ").trim();
  const flushHeading = () => {
    if (heading) {
      const text = clean(heading.text);
      if (text) output.headings.push(text.slice(0, 180));
      heading = null;
    }
  };
  const flushParagraph = () => {
    if (paragraph) {
      const text = clean(paragraph.text);
      if (text.length >= 35) output.excerpts.push(text.slice(0, 500));
      paragraph = null;
    }
  };
  let match;
  while ((match = tokens.exec(html))) {
    const token = match[0];
    if (token.startsWith("<!--") || /^<!/i.test(token)) continue;
    const tagMatch = token.match(/^<\s*(\/)?\s*([a-zA-Z][\w:-]*)\b([^>]*)>$/);
    if (!tagMatch) {
      if (token[0] !== "<" && (!hidden() || activeTitle)) {
        const text = decodeEntities(token);
        if (activeTitle) titleText += text;
        if (heading) heading.text += text;
        if (paragraph) paragraph.text += text;
      }
      continue;
    }
    const closing = Boolean(tagMatch[1]);
    const tag = tagMatch[2].toLowerCase();
    if (closing) {
      if (tag === "title") { activeTitle = false; output.title = clean(titleText).slice(0, 300); }
      if (/^h[1-6]$/.test(tag)) flushHeading();
      if (["p", "li", "blockquote"].includes(tag)) flushParagraph();
      const index = stack.lastIndexOf(tag);
      if (index >= 0) stack.length = index;
      continue;
    }
    const attrs = attributesOf(tagMatch[2] + tagMatch[3]);
    if (tag === "meta" && (attrs.name || "").toLowerCase() === "description" && attrs.content && !output.metaDescription) {
      output.metaDescription = clean(attrs.content).slice(0, 500);
    }
    if (tag === "title") { activeTitle = true; titleText = ""; }
    if (/^h[1-6]$/.test(tag)) { flushHeading(); heading = { text: "" }; }
    if (["p", "li", "blockquote"].includes(tag)) { flushParagraph(); paragraph = { text: "" }; }
    const voidTag = /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(tag);
    if (!voidTag && !/\/\s*>$/.test(token)) {
      stack.push(tag);
      // Skip raw script/style content as a unit so embedded '<' never becomes text.
      if (["script", "style"].includes(tag)) {
        const close = new RegExp("</" + tag + "\\s*>", "ig");
        close.lastIndex = tokens.lastIndex;
        const rawEnd = close.exec(html);
        if (rawEnd) {
          tokens.lastIndex = rawEnd.index;
          stack.pop();
        }
      }
    }
  }
  flushHeading();
  flushParagraph();
  output.headings = [...new Set(output.headings)].slice(0, 10);
  output.excerpts = [...new Set(output.excerpts)].slice(0, 5);
  return output;
}

function rateLimitOk(address) {
  const now = Date.now();
  const recent = (rateWindow.get(address) || []).filter((time) => now - time < 60000);
  if (recent.length >= MAX_REQUESTS_PER_MINUTE) { rateWindow.set(address, recent); return false; }
  recent.push(now);
  rateWindow.set(address, recent);
  return true;
}

function sendJson(response, status, body, origin) {
  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  if (origin === "null") {
    headers["Access-Control-Allow-Origin"] = "null";
    headers.Vary = "Origin";
  }
  response.writeHead(status, headers);
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    request.setTimeout(10000, () => request.destroy());
    request.on("data", (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_POST_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        reject(new ResearchError(413, "The research request is too large.", "request_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => tooLarge
      ? reject(new ResearchError(413, "The research request is too large.", "request_too_large"))
      : resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => reject(new ResearchError(400, "The research request could not be read.", "invalid_request")));
  });
}

async function handleResearch(request, response, origin, research) {
  if (request.method === "OPTIONS") {
    if (origin !== "null") return sendJson(response, 403, { error: "This local endpoint accepts requests only from the local-file Tracker." }, origin);
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "null", "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Private-Network": "true",
      "Access-Control-Max-Age": "300", Vary: "Origin"
    });
    return response.end();
  }
  if (request.method !== "POST") return sendJson(response, 405, { error: "Use the homepage research form to send a request." }, origin);
  if (origin && origin !== "null") return sendJson(response, 403, { error: "This local endpoint accepts requests only from the local-file Tracker." }, origin);
  if (!rateLimitOk(request.socket.remoteAddress || "local")) return sendJson(response, 429, { error: "The local request limit was reached. Wait a minute before trying again." }, origin);
  try {
    const raw = await readBody(request);
    let body;
    try { body = JSON.parse(raw); } catch (_) { throw new ResearchError(400, "The research request must contain a website URL.", "invalid_json"); }
    const result = await research(body && body.url);
    return sendJson(response, 200, result, origin);
  } catch (error) {
    const known = error instanceof ResearchError ? error : new ResearchError(502, "The homepage could not be retrieved safely.", "unexpected_failure");
    return sendJson(response, known.status || 502, { error: known.message }, origin);
  }
}

function createServer(research = researchHomepage) {
  return http.createServer((request, response) => {
    const origin = request.headers.origin || "";
    if (request.url !== "/api/research-homepage") return sendJson(response, 404, { error: "Research endpoint not found." }, origin);
    void handleResearch(request, response, origin, research);
  });
}

if (require.main === module) {
  if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) {
    process.stderr.write("Invalid port. Choose a port between 1024 and 65535.\n");
    process.exitCode = 1;
  } else {
    createServer().listen(PORT, HOST, () => {
      process.stdout.write("Homepage research backend listening on http://127.0.0.1:" + PORT + " (press Ctrl+C to stop).\n");
    }).on("error", () => {
      process.stderr.write("Could not start the local backend. Check whether port " + PORT + " is already in use.\n");
      process.exitCode = 1;
    });
  }
}

module.exports = {
  USER_AGENT, MAX_HTML_BYTES, MAX_ROBOTS_BYTES, validateUrl, isPublicAddress,
  resolvePublicHost, fetchPublic, parseRobots, robotsAllows, checkRobots, researchHomepage,
  decodeEntities, parseHtml, appendLimitedChunk, createServer, ResearchError
};
