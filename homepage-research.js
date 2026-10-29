(function () {
  "use strict";

  const form = document.getElementById("homepage-research-form");
  const urlInput = document.getElementById("homepage-url");
  const submitButton = document.getElementById("homepage-research-button");
  const message = document.getElementById("homepage-research-message");
  const result = document.getElementById("homepage-research-result");
  const ENDPOINT = "http://127.0.0.1:8787/api/research-homepage";

  function setMessage(text, state) {
    message.textContent = text;
    message.className = "research-message" + (state ? " " + state : "");
  }

  function validateUrl(value) {
    if (!value || value.length > 2048) return null;
    try {
      const parsed = new URL(value);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return null;
      if (parsed.port && !["80", "443"].includes(parsed.port)) return null;
      return parsed.href;
    } catch (_) {
      return null;
    }
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function addBlock(parent, title, values, emptyText) {
    const block = element("div", "research-block");
    block.appendChild(element("h4", "", title));
    if (!values || values.length === 0) {
      block.appendChild(element("p", "research-empty", emptyText));
    } else {
      const list = element("ul");
      values.forEach((value) => list.appendChild(element("li", "", value)));
      block.appendChild(list);
    }
    parent.appendChild(block);
  }

  function renderPreview(data) {
    result.replaceChildren();
    result.classList.remove("hidden");
    const title = typeof data.title === "string" && data.title ? data.title : "No page title found";
    result.appendChild(element("h3", "", title));

    const safeSource = validateUrl(data.sourceUrl || "");
    if (!safeSource) throw new Error("The backend returned an invalid source URL.");
    const source = element("a", "research-source", safeSource);
    source.href = safeSource;
    source.target = "_blank";
    source.rel = "noopener noreferrer";
    source.setAttribute("aria-label", "Open the final source URL in a new tab");
    result.appendChild(source);

    addBlock(result, "META DESCRIPTION", typeof data.metaDescription === "string" && data.metaDescription ? [data.metaDescription] : [], "No meta description found.");
    addBlock(result, "HEADINGS", Array.isArray(data.headings) ? data.headings.filter((value) => typeof value === "string") : [], "No headings found.");
    addBlock(result, "TEXT EXCERPTS", Array.isArray(data.excerpts) ? data.excerpts.filter((value) => typeof value === "string") : [], "No useful text excerpts found.");
    result.appendChild(element("p", "research-notice", "This is public page text for your review, not an SEO diagnosis. No finding has been saved."));
  }

  function responseMessage(status, detail) {
    if (status === 400) return detail || "Enter a valid public website URL using http or https.";
    if (status === 403) return detail || "The site blocked access or its robots.txt does not allow this check.";
    if (status === 413) return detail || "The homepage is larger than this preview allows.";
    if (status === 415) return detail || "The homepage did not return an HTML page.";
    if (status === 504) return detail || "The website took too long to respond. Try again later.";
    return detail || "The homepage could not be retrieved safely. Check the address and try again.";
  }

  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    result.replaceChildren();
    result.classList.add("hidden");
    const url = validateUrl(urlInput.value.trim());
    if (!url) {
      urlInput.setAttribute("aria-invalid", "true");
      setMessage("Enter a valid public website address that starts with http:// or https://. Local and private addresses are not allowed.", "error");
      urlInput.focus();
      return;
    }
    urlInput.removeAttribute("aria-invalid");
    submitButton.disabled = true;
    setMessage("Checking robots.txt and requesting the homepage…", "loading");

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
        signal: controller.signal
      });
      let data;
      try { data = await response.json(); } catch (_) { data = {}; }
      if (!response.ok) {
        setMessage(responseMessage(response.status, data.error), "error");
        return;
      }
      try { renderPreview(data); }
      catch (_) { setMessage("The research response did not include a safe source URL. Nothing was saved.", "error"); return; }
      if (data.empty) {
        setMessage("The homepage responded, but it contained no useful title, description, headings, or text excerpts.", "error");
      } else {
        setMessage("Homepage preview ready. Review the evidence and source URL below.", "success");
      }
    } catch (error) {
      if (error.name === "AbortError") {
        setMessage("The request timed out. The server or website may be busy; try again later.", "error");
      } else if (error instanceof TypeError) {
        setMessage("The local research backend is not reachable. Start it using the README instructions; the rest of the Tracker is still available.", "error");
      } else {
        setMessage("The homepage could not be retrieved. Please check the address and try again.", "error");
      }
    } finally {
      window.clearTimeout(timeout);
      submitButton.disabled = false;
    }
  });
})();
