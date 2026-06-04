const startScreen = document.querySelector("#startScreen");
const testScreen = document.querySelector("#testScreen");
const resultScreen = document.querySelector("#resultScreen");
const startBtn = document.querySelector("#startBtn");
const quizForm = document.querySelector("#quizForm");
const questionsEl = document.querySelector("#questions");
const sectionTitle = document.querySelector("#sectionTitle");
const progressBar = document.querySelector("#progressBar");
const progressText = document.querySelector("#progressText");
const stepList = document.querySelector("#stepList");
const backBtn = document.querySelector("#backBtn");
const nextBtn = document.querySelector("#nextBtn");
const submitBtn = document.querySelector("#submitBtn");
const restartBtn = document.querySelector("#restartBtn");
const resultTitle = document.querySelector("#resultTitle");
const resultText = document.querySelector("#resultText");
const pathList = document.querySelector("#pathList");
const firstNameInput = document.querySelector("#firstName");
const lastNameInput = document.querySelector("#lastName");
let features = [];
let openQuestions = [];
let step = 0;
let answers = {};
let openAnswers = {};
let person = {};
const sections = [
  { title: "Umumiy ma'lumotlar", from: 0, to: 4 },
  { title: "Ish haqi va rivojlanish", from: 4, to: 12 },
  { title: "Muhit va baholash", from: 12, to: 22 },
  { title: "Ishdan ketish ehtimoli", from: 22, to: 26 },
  { title: "Ochiq savollar", open: true }
];
function showOnly(screen) {
  for (const element of [startScreen, testScreen, resultScreen]) element.classList.add("hidden");
  screen.classList.remove("hidden");
}
function optionLabel(feature, value) {
  if (feature.type === "number") {
    return {
      "1": "1 - umuman qo'shilmayman",
      "2": "2",
      "3": "3",
      "4": "4",
      "5": "5 - to'liq qo'shilaman"
    }[value] || value;
  }
  return value;
}

function renderQuestion(feature) {
  const selected = answers[feature.key] || "";
  const options = feature.options.map((option) => `
    <label class="option">
      <input type="radio" name="${feature.key}" value="${escapeHtml(option)}" ${selected === option ? "checked" : ""} required>
      <span>${escapeHtml(optionLabel(feature, option))}</span>
    </label>
  `).join("");

  return `
    <article class="question">
      <h3>${escapeHtml(feature.label)}</h3>
      <div class="options">${options}</div>
    </article>
  `;
}

function renderOpenQuestion(question) {
  return `
    <article class="question">
      <h3>${escapeHtml(question.label)}</h3>
      <textarea name="${question.key}" placeholder="Javobingizni yozing">${escapeHtml(openAnswers[question.key] || "")}</textarea>
    </article>
  `;
}

function renderStep() {
  const current = sections[step];
  sectionTitle.textContent = current.title;
  backBtn.style.visibility = step === 0 ? "hidden" : "visible";
  nextBtn.classList.toggle("hidden", step === sections.length - 1);
  submitBtn.classList.toggle("hidden", step !== sections.length - 1);

  if (current.open) {
    questionsEl.innerHTML = `<div class="question-group">${openQuestions.map(renderOpenQuestion).join("")}</div>`;
  } else {
    questionsEl.innerHTML = `<div class="question-group">${features.slice(current.from, current.to).map(renderQuestion).join("")}</div>`;
  }

  const percent = Math.round((step / (sections.length - 1)) * 100);
  progressBar.style.width = `${percent}%`;
  progressText.textContent = `${percent}%`;
  stepList.innerHTML = sections.map((section, index) => `
    <div class="step-chip ${index === step ? "is-active" : ""}">
      <span>${index + 1}. ${escapeHtml(section.title)}</span>
      <strong>${index < step ? "OK" : index === step ? "Now" : ""}</strong>
    </div>
  `).join("");
}

function saveCurrentStep() {
  const data = new FormData(quizForm);
  const current = sections[step];

  if (current.open) {
    for (const question of openQuestions) openAnswers[question.key] = data.get(question.key) || "";
    return true;
  }

  const visible = features.slice(current.from, current.to);
  for (const feature of visible) {
    const value = data.get(feature.key);
    if (!value) {
      alert("Iltimos, barcha savollarga javob bering.");
      return false;
    }
    answers[feature.key] = value;
  }
  return true;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function loadQuestions() {
  const response = await fetch("/api/questions");
  if (!response.ok) throw new Error("Savollarni yuklab bo'lmadi.");
  const data = await response.json();
  features = data.features;
  openQuestions = data.openQuestions;
}

async function submitQuiz(event) {
  event.preventDefault();
  if (!saveCurrentStep()) return;

  submitBtn.disabled = true;
  submitBtn.textContent = "Tahlil qilinmoqda...";

  try {
    const response = await fetch("/api/predict", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ person, answers, openAnswers })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Natija olinmadi.");
    renderResult(data);
  } catch (error) {
    alert(error.message);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Natijani chiqarish";
  }
}

function renderResult(data) {
  resultTitle.textContent = data.result;

  const descriptions = {
    qisqa: "Model javoblaringizni qisqa muddatda ish joyini o'zgartirish ehtimoli yuqori bo'lgan guruhga yaqin deb baholadi.",
    orta: "Model javoblaringizni o'rta muddatli kuzatuv talab qiladigan guruhga yaqin deb baholadi.",
    uzoq: "Model javoblaringizni kompaniyada uzoqroq qolish ehtimoli yuqori bo'lgan guruhga yaqin deb baholadi."
  };

  resultText.textContent = `${descriptions[data.key] || ""} Qaror daraxti Excel bazadagi ${data.samples} ta yaqin namuna tuguniga tayandi.`;
  pathList.innerHTML = data.path.length
    ? data.path.map((item) => `<div class="path-item">${escapeHtml(item.label)}: <strong>${escapeHtml(item.value)}</strong></div>`).join("")
    : "";

  showOnly(resultScreen);
}

startBtn.addEventListener("click", async () => {
  person = {
    firstName: firstNameInput.value.trim(),
    lastName: lastNameInput.value.trim()
  };

  if (!person.firstName || !person.lastName) {
    alert("Iltimos, ism va familyani kiriting.");
    return;
  }

  startBtn.disabled = true;
  startBtn.textContent = "Yuklanmoqda...";
  try {
    await loadQuestions();
    step = 0;
    renderStep();
    showOnly(testScreen);
  } catch (error) {
    alert(error.message);
  } finally {
    startBtn.disabled = false;
    startBtn.textContent = "Testni boshlash";
  }
});

nextBtn.addEventListener("click", () => {
  if (!saveCurrentStep()) return;
  step = Math.min(step + 1, sections.length - 1);
  renderStep();
});

backBtn.addEventListener("click", () => {
  saveCurrentStep();
  step = Math.max(step - 1, 0);
  renderStep();
});

restartBtn.addEventListener("click", () => {
  answers = {};
  openAnswers = {};
  person = {};
  step = 0;
  renderStep();
  showOnly(startScreen);
});

quizForm.addEventListener("submit", submitQuiz);
