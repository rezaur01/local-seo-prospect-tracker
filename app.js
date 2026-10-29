(function () {
  "use strict";

  const LEGACY_STORAGE_KEY = "localSeoProspectTracker.v1";
  const STORAGE_KEY = "localSeoProspectTracker.v2";
  const STATUSES = ["Not contacted", "Contacted", "Follow up", "Not a fit"];
  const VERIFICATION_STATUSES = ["Needs checking", "Verified"];
  const LEGACY_FINDING_FIELDS = ["observations", "potentialImplication", "recommendedNextAction", "evidenceUrl"];
  const BUSINESS_FIELDS = ["id", "businessName", "niche", "website", "location", "contactDetails", "outreachStatus", "notes", "createdAt", "updatedAt"];

  const form = document.getElementById("prospect-form");
  const list = document.getElementById("prospect-list");
  const count = document.getElementById("prospect-count");
  const formTitle = document.getElementById("form-title");
  const saveButton = document.getElementById("save-button");
  const cancelButton = document.getElementById("cancel-edit-button");
  const formMessage = document.getElementById("form-message");
  const storageError = document.getElementById("storage-error");
  const searchInput = document.getElementById("prospect-search");
  const statusFilter = document.getElementById("status-filter");
  const exportButton = document.getElementById("export-button");
  const findingDialog = document.getElementById("finding-dialog");
  const findingForm = document.getElementById("finding-form");
  const findingDialogTitle = document.getElementById("finding-dialog-title");
  const findingBusinessName = document.getElementById("finding-business-name");
  const findingMessage = document.getElementById("finding-message");
  const findingSaveButton = document.getElementById("save-finding-button");
  const findingFields = {
    id: document.getElementById("finding-id"),
    prospectId: document.getElementById("finding-prospect-id"),
    observation: document.getElementById("finding-observation"),
    potentialImplication: document.getElementById("finding-implication"),
    recommendedNextAction: document.getElementById("finding-next-action"),
    evidenceUrl: document.getElementById("finding-evidence-url"),
    verificationStatus: document.getElementById("finding-verification-status")
  };
  const fields = {
    id: document.getElementById("prospect-id"),
    businessName: document.getElementById("business-name"),
    niche: document.getElementById("niche"),
    website: document.getElementById("website"),
    location: document.getElementById("location"),
    contactDetails: document.getElementById("contact-details"),
    outreachStatus: document.getElementById("outreach-status"),
    notes: document.getElementById("notes")
  };

  const loaded = loadOrMigrate();
  let prospects = loaded.prospects || [];
  const ready = loaded.error === "";

  function safeParse(raw, label) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(label + " data is not valid JSON.");
    }
    if (!Array.isArray(parsed)) throw new Error(label + " data is not a prospect list.");
    if (parsed.some((item) => !item || typeof item !== "object" || Array.isArray(item) || typeof item.id !== "string" || typeof item.businessName !== "string")) {
      throw new Error(label + " data contains a record that cannot be safely migrated.");
    }
    return parsed;
  }

  function normalizeFinding(finding, prospectId, index) {
    const item = finding && typeof finding === "object" && !Array.isArray(finding) ? finding : {};
    return {
      ...item,
      id: typeof item.id === "string" && item.id ? item.id : makeFindingId(prospectId, index),
      observation: typeof item.observation === "string" ? item.observation : "",
      potentialImplication: typeof item.potentialImplication === "string" ? item.potentialImplication : "",
      recommendedNextAction: typeof item.recommendedNextAction === "string" ? item.recommendedNextAction : "",
      evidenceUrl: typeof item.evidenceUrl === "string" ? item.evidenceUrl : "",
      verificationStatus: VERIFICATION_STATUSES.includes(item.verificationStatus) ? item.verificationStatus : "Needs checking"
    };
  }

  function validateCurrentFindings(records) {
    for (const prospect of records) {
      if (!Object.prototype.hasOwnProperty.call(prospect, "findings")) {
        // Older business-only v2 records remain valid and simply have no findings.
        if (hasLegacyResearch(prospect)) {
          throw new Error("A prospect with legacy research fields is missing its findings list.");
        }
        continue;
      }
      if (!Array.isArray(prospect.findings)) {
        throw new Error("A prospect has a findings value that is not a list.");
      }
      const ids = new Set();
      for (const finding of prospect.findings) {
        if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
          throw new Error("A saved research finding is not a valid record.");
        }
        if (typeof finding.id !== "string" || finding.id.trim() === "") {
          throw new Error("A saved research finding is missing its ID.");
        }
        if (ids.has(finding.id)) {
          throw new Error("A prospect has duplicate research finding IDs.");
        }
        ids.add(finding.id);
        if (["observation", "potentialImplication", "recommendedNextAction", "evidenceUrl"]
          .some((key) => typeof finding[key] !== "string")) {
          throw new Error("A saved research finding contains a non-text field value.");
        }
        if (!VERIFICATION_STATUSES.includes(finding.verificationStatus)) {
          throw new Error("A saved research finding has an unsupported verification status.");
        }
      }
    }
  }

  function hasLegacyResearch(prospect) {
    const hasText = LEGACY_FINDING_FIELDS.some((key) => typeof prospect[key] === "string" && prospect[key].trim() !== "");
    return hasText || prospect.verificationStatus === "Verified";
  }

  function convertLegacyRecords(oldRecords) {
    return oldRecords.map((prospect) => {
      let findings;
      if (Array.isArray(prospect.findings) && prospect.findings.length > 0) {
        findings = prospect.findings.map((finding, index) => normalizeFinding(finding, prospect.id, index));
      } else if (hasLegacyResearch(prospect)) {
        findings = [{
          id: makeFindingId(prospect.id, 0),
          observation: typeof prospect.observations === "string" ? prospect.observations : "",
          potentialImplication: typeof prospect.potentialImplication === "string" ? prospect.potentialImplication : "",
          recommendedNextAction: typeof prospect.recommendedNextAction === "string" ? prospect.recommendedNextAction : "",
          evidenceUrl: typeof prospect.evidenceUrl === "string" ? prospect.evidenceUrl : "",
          verificationStatus: VERIFICATION_STATUSES.includes(prospect.verificationStatus) ? prospect.verificationStatus : "Needs checking"
        }];
      } else {
        findings = [];
      }
      const {
        observations,
        potentialImplication,
        recommendedNextAction,
        evidenceUrl,
        verificationStatus,
        ...businessRecord
      } = prospect;
      return { ...businessRecord, findings };
    });
  }

  function validateConvertedRecords(original, converted) {
    if (!Array.isArray(converted) || converted.length !== original.length) return false;
    for (let index = 0; index < original.length; index += 1) {
      const before = original[index];
      const after = converted[index];
      if (!after || !Array.isArray(after.findings)) return false;
      for (const key of BUSINESS_FIELDS) {
        if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) return false;
      }
      for (const finding of after.findings) {
        if (typeof finding.id !== "string" || !VERIFICATION_STATUSES.includes(finding.verificationStatus)) return false;
        if (["observation", "potentialImplication", "recommendedNextAction", "evidenceUrl"].some((key) => typeof finding[key] !== "string")) return false;
      }
      if (Array.isArray(before.findings) && before.findings.length > 0 && after.findings.length !== before.findings.length) return false;
      if ((!Array.isArray(before.findings) || before.findings.length === 0) && hasLegacyResearch(before) && after.findings.length !== 1) return false;
      if ((!Array.isArray(before.findings) || before.findings.length === 0) && !hasLegacyResearch(before) && after.findings.length !== 0) return false;
    }
    return true;
  }

  function loadOrMigrate() {
    try {
      const current = window.localStorage.getItem(STORAGE_KEY);
      if (current !== null) {
        const records = safeParse(current, "Current tracker");
        validateCurrentFindings(records);
        const normalized = records.map((prospect) => ({
          ...prospect,
          findings: Object.prototype.hasOwnProperty.call(prospect, "findings") ? prospect.findings : []
        }));
        if (!validateConvertedRecords(records, normalized)) throw new Error("Current tracker records failed validation.");
        return { prospects: normalized, error: "" };
      }

      const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacy === null) return { prospects: [], error: "" };
      const originalRecords = safeParse(legacy, "Original tracker");
      const converted = convertLegacyRecords(originalRecords);
      if (!validateConvertedRecords(originalRecords, converted)) {
        throw new Error("Converted records did not pass the preservation checks.");
      }
      // One atomic write only after every record has converted and passed validation.
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(converted));
      return { prospects: converted, error: "" };
    } catch (error) {
      return {
        prospects: null,
        error: "The tracker could not safely load or migrate its saved records. No migrated data was written. Your original v1 data has been left untouched. Details: " + error.message
      };
    }
  }

  function saveProspects() {
    if (!ready) return false;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prospects));
      return true;
    } catch (error) {
      showMessage("Your browser could not save this change. The previous saved data is still available.", "error");
      return false;
    }
  }

  function valueOf(field) { return field.value.trim(); }

  function readProspectForm() {
    return {
      businessName: valueOf(fields.businessName),
      niche: valueOf(fields.niche),
      website: normalizeUrl(valueOf(fields.website)),
      location: valueOf(fields.location),
      contactDetails: valueOf(fields.contactDetails),
      outreachStatus: fields.outreachStatus.value,
      notes: valueOf(fields.notes)
    };
  }

  function normalizeUrl(value) {
    if (!value) return "";
    const candidate = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(value) ? value : "https://" + value;
    try {
      const url = new URL(candidate);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
    } catch (error) { return null; }
  }

  function clearProspectErrors() {
    ["business-name", "website"].forEach((id) => {
      const input = document.getElementById(id);
      const error = document.getElementById(id + "-error");
      if (input) input.removeAttribute("aria-invalid");
      if (error) error.textContent = "";
    });
    showMessage("", "");
  }

  function setError(id, message) {
    const input = document.getElementById(id);
    const error = document.getElementById(id + "-error");
    input.setAttribute("aria-invalid", "true");
    error.textContent = message;
  }

  function validateProspect(data) {
    clearProspectErrors();
    let valid = true;
    if (!data.businessName) { setError("business-name", "Enter a business name."); valid = false; }
    if (data.website === null) { setError("website", "Enter a valid web address (http or https)."); valid = false; }
    if (!STATUSES.includes(data.outreachStatus)) data.outreachStatus = STATUSES[0];
    return valid;
  }

  function showMessage(message, kind) {
    formMessage.textContent = message;
    formMessage.className = "form-message" + (kind ? " " + kind : "");
  }

  function makeId() {
    return window.crypto && typeof window.crypto.randomUUID === "function"
      ? window.crypto.randomUUID()
      : "prospect-" + Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  function makeFindingId(prospectId, index) {
    return "legacy-finding-" + String(prospectId).replace(/[^a-zA-Z0-9_-]/g, "_") + "-" + index;
  }

  function makeNewFindingId() {
    return window.crypto && typeof window.crypto.randomUUID === "function"
      ? window.crypto.randomUUID()
      : "finding-" + Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  function safeLink(value) {
    if (!value) return null;
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
    } catch (error) { return null; }
  }

  function addDetail(container, label, value, isUrl) {
    if (!value) return;
    const wrapper = document.createElement("div");
    wrapper.className = "detail";
    const labelElement = document.createElement("span");
    labelElement.className = "detail-label";
    labelElement.textContent = label;
    const valueElement = document.createElement("div");
    valueElement.className = "detail-value";
    const validUrl = isUrl ? safeLink(value) : null;
    if (validUrl) {
      const link = document.createElement("a");
      link.href = validUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = value;
      link.setAttribute("aria-label", label + ": open link in a new tab");
      valueElement.appendChild(link);
    } else valueElement.textContent = value;
    wrapper.append(labelElement, valueElement);
    container.appendChild(wrapper);
  }

  function statusClass(status) { return "status-" + status.toLowerCase().replace(/\s+/g, "-"); }

  function renderFinding(finding, prospect) {
    const card = document.createElement("section");
    card.className = "finding-card";
    const top = document.createElement("div");
    top.className = "finding-card-top";
    const label = document.createElement("strong");
    label.textContent = "Research finding";
    const meta = document.createElement("div");
    meta.className = "card-meta";
    const verification = document.createElement("span");
    const safeVerification = VERIFICATION_STATUSES.includes(finding.verificationStatus) ? finding.verificationStatus : "Needs checking";
    verification.className = "verification-pill" + (safeVerification === "Verified" ? " is-verified" : "");
    verification.textContent = safeVerification;
    meta.appendChild(verification);
    top.append(label, meta);

    const content = document.createElement("div");
    content.className = "finding-content";
    addDetail(content, "Observation", finding.observation, false);
    addDetail(content, "Potential implication", finding.potentialImplication, false);
    addDetail(content, "Recommended next action", finding.recommendedNextAction, false);
    addDetail(content, "Evidence URL", finding.evidenceUrl, true);

    const actions = document.createElement("div");
    actions.className = "finding-actions";
    const edit = document.createElement("button");
    edit.className = "action-button";
    edit.type = "button";
    edit.textContent = "Edit finding";
    edit.addEventListener("click", () => openFindingDialog(prospect, finding));
    const remove = document.createElement("button");
    remove.className = "action-button delete";
    remove.type = "button";
    remove.textContent = "Delete finding";
    remove.addEventListener("click", () => deleteFinding(prospect.id, finding.id));
    actions.append(edit, remove);
    card.append(top, content, actions);
    return card;
  }

  function render() {
    count.textContent = String(prospects.length);
    list.replaceChildren();
    const query = searchInput.value.trim().toLocaleLowerCase();
    const selectedStatus = statusFilter.value;
    const visibleProspects = prospects.filter((prospect) => {
      const matchesSearch = [prospect.businessName, prospect.website, prospect.niche, prospect.location]
        .some((value) => String(value || "").toLocaleLowerCase().includes(query));
      const matchesStatus = !selectedStatus || prospect.outreachStatus === selectedStatus;
      return matchesSearch && matchesStatus;
    });
    exportButton.disabled = !ready || prospects.length === 0;
    if (prospects.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      const icon = document.createElement("span");
      icon.className = "empty-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = "+";
      const title = document.createElement("strong");
      title.textContent = "Your prospect list is ready";
      const copy = document.createElement("p");
      copy.textContent = "Add your first business using the form. Your saved prospects will appear here.";
      empty.append(icon, title, copy);
      list.appendChild(empty);
      return;
    }
    if (visibleProspects.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      const title = document.createElement("strong");
      title.textContent = "No matching prospects";
      const copy = document.createElement("p");
      copy.textContent = "Try a different search or choose another outreach status.";
      empty.append(title, copy);
      list.appendChild(empty);
      return;
    }
    if (query || selectedStatus) {
      const summary = document.createElement("p");
      summary.className = "results-message";
      summary.textContent = "Showing " + visibleProspects.length + " of " + prospects.length + " prospects. CSV export includes all saved prospects and findings.";
      list.appendChild(summary);
    }

    visibleProspects.forEach((prospect) => {
      const card = document.createElement("article");
      card.className = "prospect-card";
      const top = document.createElement("div");
      top.className = "card-top";
      const titleGroup = document.createElement("div");
      titleGroup.className = "card-title";
      const heading = document.createElement("h3");
      heading.textContent = prospect.businessName;
      titleGroup.appendChild(heading);
      const subparts = [prospect.niche, prospect.location].filter(Boolean);
      if (subparts.length) {
        const subtitle = document.createElement("div");
        subtitle.className = "card-subtitle";
        subtitle.textContent = subparts.join(" · ");
        titleGroup.appendChild(subtitle);
      }
      const meta = document.createElement("div");
      meta.className = "card-meta";
      const status = document.createElement("span");
      const safeStatus = STATUSES.includes(prospect.outreachStatus) ? prospect.outreachStatus : STATUSES[0];
      status.className = "status-pill " + statusClass(safeStatus);
      status.textContent = safeStatus;
      meta.appendChild(status);
      top.append(titleGroup, meta);

      const details = document.createElement("div");
      details.className = "card-details";
      addDetail(details, "Website", prospect.website, true);
      addDetail(details, "Contact", prospect.contactDetails, false);
      addDetail(details, "Notes", prospect.notes, false);

      const findingsArea = document.createElement("div");
      findingsArea.className = "findings-area";
      const findingsHeading = document.createElement("div");
      findingsHeading.className = "findings-heading";
      const findingsTitle = document.createElement("h4");
      findingsTitle.textContent = "Research findings ";
      const findingsCount = document.createElement("span");
      findingsCount.className = "finding-count";
      findingsCount.textContent = "(" + (prospect.findings || []).length + ")";
      findingsTitle.appendChild(findingsCount);
      const add = document.createElement("button");
      add.className = "action-button";
      add.type = "button";
      add.textContent = "+ Add finding";
      add.addEventListener("click", () => openFindingDialog(prospect, null));
      findingsHeading.append(findingsTitle, add);
      const findingsList = document.createElement("div");
      findingsList.className = "finding-list";
      const findings = Array.isArray(prospect.findings) ? prospect.findings : [];
      if (findings.length === 0) {
        const noFindings = document.createElement("p");
        noFindings.className = "no-findings";
        noFindings.textContent = "No research findings yet.";
        findingsList.appendChild(noFindings);
      } else findings.forEach((finding) => findingsList.appendChild(renderFinding(finding, prospect)));
      findingsArea.append(findingsHeading, findingsList);

      const actions = document.createElement("div");
      actions.className = "card-actions";
      const edit = document.createElement("button");
      edit.className = "action-button";
      edit.type = "button";
      edit.textContent = "Edit business";
      edit.setAttribute("aria-label", "Edit business details for " + prospect.businessName);
      edit.addEventListener("click", () => beginEdit(prospect.id));
      const remove = document.createElement("button");
      remove.className = "action-button delete";
      remove.type = "button";
      remove.textContent = "Delete business";
      remove.setAttribute("aria-label", "Delete " + prospect.businessName);
      remove.addEventListener("click", () => deleteProspect(prospect.id));
      actions.append(edit, remove);
      card.append(top, details, findingsArea, actions);
      list.appendChild(card);
    });
  }

  function beginEdit(id) {
    const prospect = prospects.find((item) => item.id === id);
    if (!prospect) return;
    fields.id.value = prospect.id;
    fields.businessName.value = prospect.businessName || "";
    fields.niche.value = prospect.niche || "";
    fields.website.value = prospect.website || "";
    fields.location.value = prospect.location || "";
    fields.contactDetails.value = prospect.contactDetails || "";
    fields.outreachStatus.value = STATUSES.includes(prospect.outreachStatus) ? prospect.outreachStatus : STATUSES[0];
    fields.notes.value = prospect.notes || "";
    formTitle.textContent = "Edit business";
    saveButton.textContent = "Save changes";
    cancelButton.classList.remove("hidden");
    clearProspectErrors();
    fields.businessName.focus();
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function resetProspectForm() {
    form.reset();
    fields.id.value = "";
    fields.outreachStatus.value = STATUSES[0];
    formTitle.textContent = "Add a prospect";
    saveButton.textContent = "Save prospect";
    cancelButton.classList.add("hidden");
    clearProspectErrors();
  }

  function deleteProspect(id) {
    const prospect = prospects.find((item) => item.id === id);
    if (!prospect || !window.confirm("Delete “" + prospect.businessName + "” and all its research findings? This cannot be undone.")) return;
    const previous = prospects;
    prospects = prospects.filter((item) => item.id !== id);
    if (!saveProspects()) { prospects = previous; render(); return; }
    if (fields.id.value === id) resetProspectForm();
    render();
  }

  function showFindingError(message) {
    findingMessage.textContent = message;
    findingMessage.className = "form-message" + (message ? " error" : "");
  }

  function openFindingDialog(prospect, finding) {
    findingForm.reset();
    findingFields.id.value = finding ? finding.id : "";
    findingFields.prospectId.value = prospect.id;
    findingBusinessName.textContent = prospect.businessName;
    findingDialogTitle.textContent = finding ? "Edit finding" : "Add finding";
    findingSaveButton.textContent = finding ? "Save changes" : "Save finding";
    findingFields.observation.value = finding ? finding.observation || "" : "";
    findingFields.potentialImplication.value = finding ? finding.potentialImplication || "" : "";
    findingFields.recommendedNextAction.value = finding ? finding.recommendedNextAction || "" : "";
    findingFields.evidenceUrl.value = finding ? finding.evidenceUrl || "" : "";
    findingFields.verificationStatus.value = finding && VERIFICATION_STATUSES.includes(finding.verificationStatus)
      ? finding.verificationStatus : "Needs checking";
    document.getElementById("finding-evidence-url").removeAttribute("aria-invalid");
    document.getElementById("finding-evidence-url-error").textContent = "";
    showFindingError("");
    findingDialog.showModal();
    findingFields.observation.focus();
  }

  function closeFindingDialog() {
    if (findingDialog.open) findingDialog.close();
  }

  function readFindingForm() {
    return {
      observation: valueOf(findingFields.observation),
      potentialImplication: valueOf(findingFields.potentialImplication),
      recommendedNextAction: valueOf(findingFields.recommendedNextAction),
      evidenceUrl: normalizeUrl(valueOf(findingFields.evidenceUrl)),
      verificationStatus: VERIFICATION_STATUSES.includes(findingFields.verificationStatus.value)
        ? findingFields.verificationStatus.value : "Needs checking"
    };
  }

  function deleteFinding(prospectId, findingId) {
    const prospect = prospects.find((item) => item.id === prospectId);
    const finding = prospect && prospect.findings.find((item) => item.id === findingId);
    if (!prospect || !finding || !window.confirm("Delete this research finding? This cannot be undone.")) return;
    const previous = prospects;
    prospects = prospects.map((item) => item.id === prospectId
      ? { ...item, findings: item.findings.filter((entry) => entry.id !== findingId) }
      : item);
    if (!saveProspects()) { prospects = previous; render(); return; }
    render();
  }

  function handleProspectSubmit(event) {
    event.preventDefault();
    const data = readProspectForm();
    if (!validateProspect(data)) {
      showMessage("Please review the highlighted fields.", "error");
      const firstInvalid = form.querySelector('[aria-invalid="true"]');
      if (firstInvalid) firstInvalid.focus();
      return;
    }
    const editId = fields.id.value;
    const previous = prospects;
    if (editId) {
      prospects = prospects.map((item) => item.id === editId ? { ...item, ...data, updatedAt: new Date().toISOString() } : item);
    } else {
      prospects = [{ id: makeId(), ...data, findings: [], createdAt: new Date().toISOString() }, ...prospects];
    }
    if (!saveProspects()) { prospects = previous; render(); return; }
    render();
    resetProspectForm();
    showMessage(editId ? "Business details updated." : "Prospect saved. Add research findings from its card.", "success");
  }

  function handleFindingSubmit(event) {
    event.preventDefault();
    const data = readFindingForm();
    const evidenceInput = document.getElementById("finding-evidence-url");
    const evidenceError = document.getElementById("finding-evidence-url-error");
    evidenceInput.removeAttribute("aria-invalid");
    evidenceError.textContent = "";
    if (data.evidenceUrl === null) {
      evidenceInput.setAttribute("aria-invalid", "true");
      evidenceError.textContent = "Enter a valid web address (http or https).";
      showFindingError("Please review the highlighted field.");
      evidenceInput.focus();
      return;
    }
    const prospectId = findingFields.prospectId.value;
    const findingId = findingFields.id.value;
    const previous = prospects;
    const savedFinding = { ...data, id: findingId || makeNewFindingId(), updatedAt: new Date().toISOString() };
    prospects = prospects.map((item) => {
      if (item.id !== prospectId) return item;
      const findings = Array.isArray(item.findings) ? item.findings : [];
      return {
        ...item,
        findings: findingId
          ? findings.map((finding) => finding.id === findingId ? { ...finding, ...savedFinding } : finding)
          : [...findings, { ...savedFinding, createdAt: new Date().toISOString() }]
      };
    });
    if (!saveProspects()) { prospects = previous; render(); return; }
    closeFindingDialog();
    render();
  }

  function getSavedProspectsForExport() {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      const parsed = stored ? JSON.parse(stored) : [];
      if (!Array.isArray(parsed)) throw new Error("Current saved tracker is not a list.");
      return parsed;
    } catch (error) {
      showMessage("Saved records could not be read for export. Refresh the page and try again.", "error");
      return null;
    }
  }

  function csvCell(value) {
    let text = value == null ? "" : String(value);
    if (/^[\s]*[=+@\-]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }

  function exportCsv() {
    const savedProspects = getSavedProspectsForExport();
    if (!savedProspects) return;
    if (savedProspects.length === 0) { showMessage("There are no saved prospects to export yet.", "error"); return; }
    const columns = [
      ["Business name", "businessName"], ["Niche", "niche"], ["Website", "website"],
      ["Location", "location"], ["Contact details", "contactDetails"], ["Outreach status", "outreachStatus"],
      ["Prospect notes", "notes"], ["Finding ID", "findingId"], ["Research observation", "observation"],
      ["Potential implication", "potentialImplication"], ["Recommended next action", "recommendedNextAction"],
      ["Evidence URL", "evidenceUrl"], ["Verification status", "verificationStatus"]
    ];
    const rows = [columns.map(([label]) => csvCell(label)).join(",")];
    savedProspects.forEach((prospect) => {
      const findings = Array.isArray(prospect.findings) && prospect.findings.length ? prospect.findings : [null];
      findings.forEach((finding) => {
        const row = columns.map(([, key]) => {
          if (key === "findingId") return csvCell(finding && finding.id);
          if (["observation", "potentialImplication", "recommendedNextAction", "evidenceUrl", "verificationStatus"].includes(key)) {
            if (!finding) return csvCell("");
            const value = key === "verificationStatus" && !VERIFICATION_STATUSES.includes(finding[key])
              ? "Needs checking" : finding[key];
            return csvCell(value);
          }
          return csvCell(prospect[key]);
        });
        rows.push(row.join(","));
      });
    });
    const blob = new Blob(["\uFEFF" + rows.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "local-seo-prospects.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    showMessage("CSV exported with one row per finding; prospects without findings are included.", "success");
  }

  form.addEventListener("submit", handleProspectSubmit);
  cancelButton.addEventListener("click", resetProspectForm);
  searchInput.addEventListener("input", render);
  statusFilter.addEventListener("change", render);
  exportButton.addEventListener("click", exportCsv);
  findingForm.addEventListener("submit", handleFindingSubmit);
  document.getElementById("cancel-finding-button").addEventListener("click", closeFindingDialog);
  document.getElementById("close-finding-dialog").addEventListener("click", closeFindingDialog);
  findingDialog.addEventListener("click", (event) => { if (event.target === findingDialog) closeFindingDialog(); });

  if (!ready) {
    storageError.textContent = loaded.error;
    storageError.classList.remove("hidden");
    form.querySelectorAll("input, textarea, select, button").forEach((control) => { control.disabled = true; });
    searchInput.disabled = true;
    statusFilter.disabled = true;
    exportButton.disabled = true;
    list.replaceChildren();
  } else {
    render();
  }
})();
