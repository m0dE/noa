/**
 * Noa's own fixed lines in the language the user picked (Settings > AI > Voice > Language; language.ts): the progress
 * lines hands-free voice says while the agent works (milestones.ts: "Opening x.com", "Still reading the page"), the
 * approval question, Standard's "use this tab" answers, notifications (notify.ts) and the Test voice samples. The
 * English line is translated where it is said or shown, so the code that decides what to say stays in one language.
 * A line not listed here (the agent's own words, which it already writes in the user's language, an error) is left as
 * it is. Pure.
 */
import type { LanguageCode } from "@noa/shared";

type Lang = Exclude<LanguageCode, "en">;
type Lines = Record<Lang, string>;
type Template = Record<Lang, (arg: string) => string>;

/** Whole lines. */
const EXACT: Record<string, Lines> = {
  // Progress (milestones.ts milestoneOf)
  "Opening a page": {
    es: "Abriendo una página", pt: "Abrindo uma página", fr: "J'ouvre une page", de: "Ich öffne eine Seite", ko: "페이지를 여는 중이에요",
    ja: "ページを開いています", zh: "正在打开一个页面", hi: "एक पेज खोल रहे हैं", ar: "جارٍ فتح صفحة",
  },
  "Opening a tab": {
    es: "Abriendo una pestaña", pt: "Abrindo uma aba", fr: "J'ouvre un onglet", de: "Ich öffne einen Tab", ko: "탭을 여는 중이에요",
    ja: "タブを開いています", zh: "正在打开一个标签页", hi: "एक टैब खोल रहे हैं", ar: "جارٍ فتح علامة تبويب",
  },
  "Reading the page": {
    es: "Leyendo la página", pt: "Lendo a página", fr: "Je lis la page", de: "Ich lese die Seite", ko: "페이지를 읽는 중이에요",
    ja: "ページを読んでいます", zh: "正在阅读页面", hi: "पेज पढ़ रहे हैं", ar: "جارٍ قراءة الصفحة",
  },
  "Looking at the page": {
    es: "Mirando la página", pt: "Olhando a página", fr: "Je regarde la page", de: "Ich schaue mir die Seite an", ko: "페이지를 보는 중이에요",
    ja: "ページを見ています", zh: "正在查看页面", hi: "पेज देख रहे हैं", ar: "جارٍ النظر في الصفحة",
  },
  "Filling in the form": {
    es: "Rellenando el formulario", pt: "Preenchendo o formulário", fr: "Je remplis le formulaire", de: "Ich fülle das Formular aus", ko: "양식을 작성하는 중이에요",
    ja: "フォームに入力しています", zh: "正在填写表单", hi: "फ़ॉर्म भर रहे हैं", ar: "جارٍ ملء النموذج",
  },
  Typing: {
    es: "Escribiendo", pt: "Digitando", fr: "Je tape le texte", de: "Ich tippe", ko: "입력하는 중이에요",
    ja: "入力しています", zh: "正在输入", hi: "टाइप कर रहे हैं", ar: "جارٍ الكتابة",
  },
  "Clicking through the page": {
    es: "Navegando por la página", pt: "Navegando pela página", fr: "Je parcours la page", de: "Ich klicke mich durch die Seite", ko: "페이지를 살펴보는 중이에요",
    ja: "ページを操作しています", zh: "正在页面上操作", hi: "पेज पर क्लिक कर रहे हैं", ar: "جارٍ التنقل في الصفحة",
  },
  Scrolling: {
    es: "Desplazándome por la página", pt: "Rolando a página", fr: "Je fais défiler la page", de: "Ich scrolle", ko: "스크롤하는 중이에요",
    ja: "スクロールしています", zh: "正在滚动页面", hi: "स्क्रॉल कर रहे हैं", ar: "جارٍ التمرير",
  },
  "Attaching files": {
    es: "Adjuntando archivos", pt: "Anexando arquivos", fr: "Je joins des fichiers", de: "Ich hänge Dateien an", ko: "파일을 첨부하는 중이에요",
    ja: "ファイルを添付しています", zh: "正在添加附件", hi: "फ़ाइलें अटैच कर रहे हैं", ar: "جارٍ إرفاق الملفات",
  },
  "Switching tabs": {
    es: "Cambiando de pestaña", pt: "Trocando de aba", fr: "Je change d'onglet", de: "Ich wechsle den Tab", ko: "탭을 바꾸는 중이에요",
    ja: "タブを切り替えています", zh: "正在切换标签页", hi: "टैब बदल रहे हैं", ar: "جارٍ تبديل علامة التبويب",
  },
  "Switching accounts": {
    es: "Cambiando de cuenta", pt: "Trocando de conta", fr: "Je change de compte", de: "Ich wechsle das Konto", ko: "계정을 바꾸는 중이에요",
    ja: "アカウントを切り替えています", zh: "正在切换账号", hi: "अकाउंट बदल रहे हैं", ar: "جارٍ تبديل الحساب",
  },
  "Signing in": {
    es: "Iniciando sesión", pt: "Entrando na conta", fr: "Je me connecte", de: "Ich melde mich an", ko: "로그인하는 중이에요",
    ja: "ログインしています", zh: "正在登录", hi: "साइन इन कर रहे हैं", ar: "جارٍ تسجيل الدخول",
  },
  "Still working on it": {
    es: "Sigo trabajando en ello", pt: "Ainda trabalhando nisso", fr: "Je travaille encore dessus", de: "Ich arbeite noch daran", ko: "아직 작업하는 중이에요",
    ja: "まだ作業しています", zh: "仍在处理中", hi: "अभी भी इस पर काम चल रहा है", ar: "ما زلت أعمل على ذلك",
  },
  // Standard's answers to "use this tab" (hands-free-tab.ts useThisTabLine)
  "I can't tell which tab you're looking at. Press Use voice here in the side panel.": {
    es: "No sé qué pestaña estás mirando. Pulsa Use voice here en el panel lateral.",
    pt: "Não sei qual aba você está olhando. Toque em Use voice here no painel lateral.",
    fr: "Je ne sais pas quel onglet vous regardez. Appuyez sur Use voice here dans le panneau latéral.",
    de: "Ich weiß nicht, welchen Tab du ansiehst. Drück im Seitenbereich auf Use voice here.",
    ko: "어떤 탭을 보고 계신지 모르겠어요. 사이드 패널에서 Use voice here를 눌러 주세요.",
    ja: "どのタブを見ているのか分かりません。サイドパネルの Use voice here を押してください。",
    zh: "我不知道你在看哪个标签页。请在侧边栏中点按 Use voice here。",
    hi: "पता नहीं आप कौन सा टैब देख रहे हैं। साइड पैनल में Use voice here दबाएँ।",
    ar: "لا أعرف أي علامة تبويب تنظر إليها. اضغط Use voice here في اللوحة الجانبية.",
  },
  "I'm already working in this tab.": {
    es: "Ya estoy trabajando en esta pestaña.", pt: "Já estou trabalhando nesta aba.", fr: "Je travaille déjà dans cet onglet.",
    de: "Ich arbeite schon in diesem Tab.", ko: "이미 이 탭에서 작업하고 있어요.", ja: "すでにこのタブで作業しています。",
    zh: "我已经在这个标签页里工作了。", hi: "मैं पहले से इसी टैब में काम कर रहा हूँ।", ar: "أنا أعمل بالفعل في علامة التبويب هذه.",
  },
  "That tab is gone.": {
    es: "Esa pestaña ya no existe.", pt: "Essa aba não existe mais.", fr: "Cet onglet n'existe plus.", de: "Dieser Tab ist nicht mehr da.",
    ko: "그 탭은 닫혔어요.", ja: "そのタブはもうありません。", zh: "那个标签页已经关闭了。", hi: "वह टैब अब नहीं है।", ar: "علامة التبويب تلك لم تعد موجودة.",
  },
  // Notifications (background.ts, engine/run/failure-policy.ts, due-loop.ts)
  "needs your OK": {
    es: "necesita tu aprobación", pt: "precisa da sua aprovação", fr: "attend votre accord", de: "braucht dein OK", ko: "승인이 필요해요",
    ja: "承認が必要です", zh: "需要你的批准", hi: "आपकी मंज़ूरी चाहिए", ar: "تحتاج إلى موافقتك",
  },
  "Working on it in the background. Open the side panel to watch or stop it.": {
    es: "Trabajando en ello en segundo plano. Abre el panel lateral para verlo o detenerlo.",
    pt: "Trabalhando nisso em segundo plano. Abra o painel lateral para acompanhar ou parar.",
    fr: "Je m'en occupe en arrière-plan. Ouvrez le panneau latéral pour suivre ou arrêter.",
    de: "Ich arbeite im Hintergrund daran. Öffne den Seitenbereich, um zuzusehen oder es zu stoppen.",
    ko: "백그라운드에서 작업하고 있어요. 사이드 패널을 열면 지켜보거나 멈출 수 있어요.",
    ja: "バックグラウンドで作業しています。サイドパネルを開くと、様子を見たり止めたりできます。",
    zh: "正在后台处理。打开侧边栏可以查看或停止。",
    hi: "बैकग्राउंड में इस पर काम चल रहा है। देखने या रोकने के लिए साइड पैनल खोलें।",
    ar: "أعمل على ذلك في الخلفية. افتح اللوحة الجانبية للمتابعة أو الإيقاف.",
  },
  "Working on it in the background.": {
    es: "Trabajando en ello en segundo plano.", pt: "Trabalhando nisso em segundo plano.", fr: "Je m'en occupe en arrière-plan.",
    de: "Ich arbeite im Hintergrund daran.", ko: "백그라운드에서 작업하고 있어요.", ja: "バックグラウンドで作業しています。",
    zh: "正在后台处理。", hi: "बैकग्राउंड में इस पर काम चल रहा है।", ar: "أعمل على ذلك في الخلفية.",
  },
  "Task paused": {
    es: "Tarea en pausa", pt: "Tarefa pausada", fr: "Tâche en pause", de: "Aufgabe pausiert", ko: "작업이 일시 중지됐어요",
    ja: "タスクを一時停止しました", zh: "任务已暂停", hi: "काम रोका गया", ar: "تم إيقاف المهمة مؤقتًا",
  },
  "The task needs your attention.": {
    es: "La tarea necesita tu atención.", pt: "A tarefa precisa da sua atenção.", fr: "La tâche demande votre attention.",
    de: "Die Aufgabe braucht deine Aufmerksamkeit.", ko: "작업을 확인해 주세요.", ja: "タスクの確認が必要です。",
    zh: "任务需要你处理。", hi: "इस काम पर आपका ध्यान चाहिए।", ar: "المهمة تحتاج إلى انتباهك.",
  },
  "Cannot run tasks": {
    es: "No se pueden ejecutar tareas", pt: "Não é possível executar tarefas", fr: "Impossible d'exécuter les tâches", de: "Aufgaben können nicht laufen",
    ko: "작업을 실행할 수 없어요", ja: "タスクを実行できません", zh: "无法运行任务", hi: "काम नहीं चल सकते", ar: "لا يمكن تشغيل المهام",
  },
  // The sample job of Test (Settings > AI > Voice > Notifications)
  "Post a tip on X": {
    es: "Publicar un consejo en X", pt: "Publicar uma dica no X", fr: "Publier une astuce sur X", de: "Einen Tipp auf X posten", ko: "X에 팁 올리기",
    ja: "X にヒントを投稿", zh: "在 X 上发布一条小贴士", hi: "X पर एक टिप पोस्ट करें", ar: "نشر نصيحة على X",
  },
  // Test voice (options/voice-section.ts SPEECH_SAMPLE)
  "Opening Gmail. You have two new emails; Jordan needs a reply by Friday.": {
    es: "Abriendo Gmail. Tienes dos correos nuevos; Jordan necesita una respuesta antes del viernes.",
    pt: "Abrindo o Gmail. Você tem dois e-mails novos; Jordan precisa de uma resposta até sexta.",
    fr: "J'ouvre Gmail. Vous avez deux nouveaux e-mails ; Jordan attend une réponse d'ici vendredi.",
    de: "Ich öffne Gmail. Du hast zwei neue E-Mails; Jordan braucht bis Freitag eine Antwort.",
    ko: "Gmail을 여는 중이에요. 새 이메일이 두 통 있어요. Jordan이 금요일까지 답장을 기다려요.",
    ja: "Gmail を開いています。新しいメールが2通あります。Jordan さんが金曜日までの返信を待っています。",
    zh: "正在打开 Gmail。你有两封新邮件；Jordan 需要你在周五前回复。",
    hi: "Gmail खोल रहे हैं। आपके दो नए ईमेल हैं; Jordan को शुक्रवार तक जवाब चाहिए।",
    ar: "جارٍ فتح Gmail. لديك رسالتان جديدتان؛ يحتاج Jordan إلى رد قبل يوم الجمعة.",
  },
};

/** Lines with one part that is not translated (a site, a count, a title, the agent's words): the whole line must match. */
const TEMPLATES: { re: RegExp; to: Template; inner?: boolean }[] = [
  {
    re: /^Opening (\d+) tabs$/,
    to: {
      es: (n) => `Abriendo ${n} pestañas`, pt: (n) => `Abrindo ${n} abas`, fr: (n) => `J'ouvre ${n} onglets`, de: (n) => `Ich öffne ${n} Tabs`,
      ko: (n) => `탭 ${n}개를 여는 중이에요`, ja: (n) => `タブを${n}個開いています`, zh: (n) => `正在打开 ${n} 个标签页`, hi: (n) => `${n} टैब खोल रहे हैं`,
      ar: (n) => `جارٍ فتح ${n} علامات تبويب`,
    },
  },
  {
    re: /^Opening (.+)$/,
    to: {
      es: (s) => `Abriendo ${s}`, pt: (s) => `Abrindo ${s}`, fr: (s) => `J'ouvre ${s}`, de: (s) => `Ich öffne ${s}`, ko: (s) => `${s} 여는 중이에요`,
      ja: (s) => `${s} を開いています`, zh: (s) => `正在打开 ${s}`, hi: (s) => `${s} खोल रहे हैं`, ar: (s) => `جارٍ فتح ${s}`,
    },
  },
  {
    re: /^Reading (\d+) pages$/,
    to: {
      es: (n) => `Leyendo ${n} páginas`, pt: (n) => `Lendo ${n} páginas`, fr: (n) => `Je lis ${n} pages`, de: (n) => `Ich lese ${n} Seiten`,
      ko: (n) => `페이지 ${n}개를 읽는 중이에요`, ja: (n) => `${n}ページを読んでいます`, zh: (n) => `正在阅读 ${n} 个页面`, hi: (n) => `${n} पेज पढ़ रहे हैं`,
      ar: (n) => `جارٍ قراءة ${n} صفحات`,
    },
  },
  {
    re: /^Switching to (@\S+)$/,
    to: {
      es: (h) => `Cambiando a ${h}`, pt: (h) => `Mudando para ${h}`, fr: (h) => `Je passe à ${h}`, de: (h) => `Ich wechsle zu ${h}`, ko: (h) => `${h} 계정으로 바꾸는 중이에요`,
      ja: (h) => `${h} に切り替えています`, zh: (h) => `正在切换到 ${h}`, hi: (h) => `${h} पर स्विच कर रहे हैं`, ar: (h) => `جارٍ التبديل إلى ${h}`,
    },
  },
  {
    re: /^Signing in to (.+)$/,
    to: {
      es: (s) => `Iniciando sesión en ${s}`, pt: (s) => `Entrando em ${s}`, fr: (s) => `Je me connecte à ${s}`, de: (s) => `Ich melde mich bei ${s} an`,
      ko: (s) => `${s}에 로그인하는 중이에요`, ja: (s) => `${s} にログインしています`, zh: (s) => `正在登录 ${s}`, hi: (s) => `${s} में साइन इन कर रहे हैं`,
      ar: (s) => `جارٍ تسجيل الدخول إلى ${s}`,
    },
  },
  {
    re: /^Now working in (.+)\.$/,
    to: {
      es: (t) => `Ahora trabajo en ${t}.`, pt: (t) => `Agora estou trabalhando em ${t}.`, fr: (t) => `Je travaille maintenant dans ${t}.`,
      de: (t) => `Ich arbeite jetzt in ${t}.`, ko: (t) => `이제 ${t}에서 작업해요.`, ja: (t) => `これからは ${t} で作業します。`,
      zh: (t) => `现在在 ${t} 中工作。`, hi: (t) => `अब ${t} में काम कर रहे हैं।`, ar: (t) => `أعمل الآن في ${t}.`,
    },
  },
  {
    // approval-voice.ts approvalLine: the action is the agent's description of it.
    re: /^Approval needed: (.+)\. Say yes to allow it, or no\.$/,
    to: {
      es: (a) => `Necesito tu permiso: ${a}. Di sí para permitirlo, o no.`,
      pt: (a) => `Preciso da sua permissão: ${a}. Diga sim para permitir, ou não.`,
      fr: (a) => `J'ai besoin de votre accord : ${a}. Dites oui pour l'autoriser, ou non.`,
      de: (a) => `Ich brauche deine Erlaubnis: ${a}. Sag ja, um es zu erlauben, oder nein.`,
      ko: (a) => `승인이 필요해요: ${a}. 허락하려면 네, 아니면 아니요라고 말해 주세요.`,
      ja: (a) => `承認が必要です: ${a}。許可するなら「はい」、しないなら「いいえ」と言ってください。`,
      zh: (a) => `需要你的批准：${a}。说“好的”就允许，说“不”就拒绝。`,
      hi: (a) => `आपकी मंज़ूरी चाहिए: ${a}. अनुमति देने के लिए हाँ कहें, या ना।`,
      ar: (a) => `أحتاج إلى موافقتك: ${a}. قل نعم للسماح بذلك، أو لا.`,
    },
  },
  {
    re: /^(.+)\. Answer in the side panel\.$/,
    to: {
      es: (x) => `${x}. Responde en el panel lateral.`, pt: (x) => `${x}. Responda no painel lateral.`, fr: (x) => `${x}. Répondez dans le panneau latéral.`,
      de: (x) => `${x}. Antworte im Seitenbereich.`, ko: (x) => `${x}. 사이드 패널에서 답해 주세요.`, ja: (x) => `${x}。サイドパネルで答えてください。`,
      zh: (x) => `${x}。请在侧边栏中回复。`, hi: (x) => `${x}. साइड पैनल में जवाब दें।`, ar: (x) => `${x}. أجب في اللوحة الجانبية.`,
    },
  },
  {
    re: /^Started: (.+)$/,
    inner: true,
    to: {
      es: (t) => `Comenzó: ${t}`, pt: (t) => `Começou: ${t}`, fr: (t) => `Démarré : ${t}`, de: (t) => `Gestartet: ${t}`, ko: (t) => `시작했어요: ${t}`,
      ja: (t) => `開始しました: ${t}`, zh: (t) => `已开始：${t}`, hi: (t) => `शुरू हुआ: ${t}`, ar: (t) => `بدأ: ${t}`,
    },
  },
  {
    re: /^Noa started working on: (.+)$/,
    inner: true,
    to: {
      es: (t) => `Noa empezó a trabajar en: ${t}`, pt: (t) => `Noa começou a trabalhar em: ${t}`, fr: (t) => `Noa a commencé : ${t}`,
      de: (t) => `Noa hat angefangen mit: ${t}`, ko: (t) => `Noa가 작업을 시작했어요: ${t}`, ja: (t) => `Noa が作業を始めました: ${t}`,
      zh: (t) => `Noa 开始处理：${t}`, hi: (t) => `Noa ने काम शुरू किया: ${t}`, ar: (t) => `بدأت Noa العمل على: ${t}`,
    },
  },
  {
    re: /^Paused: (.+)$/,
    to: {
      es: (t) => `En pausa: ${t}`, pt: (t) => `Pausada: ${t}`, fr: (t) => `En pause : ${t}`, de: (t) => `Pausiert: ${t}`, ko: (t) => `일시 중지됨: ${t}`,
      ja: (t) => `一時停止: ${t}`, zh: (t) => `已暂停：${t}`, hi: (t) => `रोका गया: ${t}`, ar: (t) => `متوقفة مؤقتًا: ${t}`,
    },
  },
  {
    re: /^Failing: (.+)$/,
    to: {
      es: (t) => `Falla una y otra vez: ${t}`, pt: (t) => `Falhando seguidamente: ${t}`, fr: (t) => `Échecs répétés : ${t}`, de: (t) => `Schlägt wiederholt fehl: ${t}`,
      ko: (t) => `계속 실패하고 있어요: ${t}`, ja: (t) => `失敗が続いています: ${t}`, zh: (t) => `持续失败：${t}`, hi: (t) => `बार-बार विफल: ${t}`,
      ar: (t) => `تفشل باستمرار: ${t}`,
    },
  },
];

/** "Still <what it does now>" (milestones.ts ProgressPacer.stillWorking), from the step's translated line. */
const STILL: Template = {
  es: (x) => `Sigo ${lowerFirst(x)}`,
  pt: (x) => `Ainda ${lowerFirst(x)}`,
  fr: (x) => `${x}, encore un instant`,
  de: (x) => `${x}, einen Moment noch`,
  ko: (x) => `아직 ${x}`,
  ja: (x) => `まだ${x}`,
  zh: (x) => x.replace(/^正在/, "仍在"),
  hi: (x) => `अभी भी ${x}`,
  ar: (x) => `${x}، لحظة من فضلك`,
};

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** `text` in `lang` when it is one of Noa's own lines; else as it is (English, or a line not listed). */
export function localizeLine(text: string, lang: LanguageCode | null | undefined): string {
  if (!lang || lang === "en") return text;
  const exact = EXACT[text]?.[lang];
  if (exact) return exact;
  for (const t of TEMPLATES) {
    const m = t.re.exec(text);
    if (m) return t.to[lang](t.inner ? (EXACT[m[1]!]?.[lang] ?? m[1]!) : m[1]!);
  }
  const still = /^Still (.+)$/.exec(text);
  if (still) {
    const step = upperFirst(still[1]!);
    const said = localizeLine(step, lang);
    if (said !== step) return STILL[lang](said);
  }
  return text;
}
