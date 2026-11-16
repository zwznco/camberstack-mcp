/**
 * One-click survey email (projects/camberstack/SURVEY-EMAIL.md): "which should Camberstack get better at first?", six answers,
 * each a signed per-user link, so a click is the answer and nobody has to reply. Sent as an announcement preset
 * (announce.ts, id SURVEY_ID), in the recipient's language.
 *
 * Language: no locale is stored, so users.time_zone (their Google Ads account's zone) stands in. Weak (India reads as English,
 * a Gulf zone may be an English-speaking expat), so each translated email ends with one English line. Only languages with 3+
 * users on 2026-11-15 are translated; everything else is English.
 *
 * Link scanners: corporate mail filters fetch every link in an email, which would "answer" all six. So the GET page records
 * nothing: it posts the answer from JavaScript as it loads (scanners rarely run it), with a button as the fallback.
 * Every click is kept; the admin counts each user's latest.
 */
import express, { type Express } from "express";
import type { DB } from "./db.js";
import { now } from "./db.js";
import { safeEqual, sign } from "./crypto.js";
import { esc } from "./pages.js";

export const SURVEY_ID = "next-2026-11";
export const CHOICES = ["answers", "conversions", "search_terms", "keywords", "reports", "enough"] as const;
export type Choice = typeof CHOICES[number];
export const LANGS = ["en", "pt", "es", "ar", "tr", "fr", "de", "zh"] as const;
export type Lang = typeof LANGS[number];

/** The language a time zone most likely reads, among LANGS; English when unknown. */
export function langFor(tz: string | null | undefined): Lang {
  const z = tz ?? "";
  if (/^America\/(Sao_Paulo|Fortaleza|Recife|Bahia|Belem|Manaus|Cuiaba|Campo_Grande|Porto_Velho|Araguaina|Maceio|Noronha|Santarem|Boa_Vista|Rio_Branco)$|^Europe\/Lisbon$/.test(z)) return "pt";
  if (/^America\/(Mexico_City|Monterrey|Merida|Cancun|Tijuana|Hermosillo|Chihuahua|Mazatlan|Bogota|Lima|Buenos_Aires|Argentina\/.+|Santiago|Caracas|Panama|Guatemala|Costa_Rica|El_Salvador|Tegucigalpa|Managua|Montevideo|Asuncion|La_Paz|Guayaquil|Santo_Domingo|Havana)$|^Europe\/Madrid$|^Atlantic\/Canary$/.test(z)) return "es";
  if (/^Europe\/Istanbul$|^Asia\/Istanbul$/.test(z)) return "tr";
  if (/^Asia\/(Riyadh|Dubai|Beirut|Amman|Baghdad|Kuwait|Qatar|Bahrain|Muscat|Aden|Damascus)$|^Africa\/(Cairo|Casablanca|Algiers|Tunis|Tripoli|Khartoum)$/.test(z)) return "ar";
  if (/^Europe\/(Paris|Brussels|Luxembourg|Monaco)$/.test(z)) return "fr";
  if (/^Europe\/(Berlin|Vienna|Zurich|Busingen)$/.test(z)) return "de";
  if (/^Asia\/(Shanghai|Hong_Kong|Chongqing|Harbin|Urumqi|Macau)$/.test(z)) return "zh";
  return "en";
}

interface Copy {
  subject: string; hi: string; intro: string; options: Record<Choice, string>; bye: string;
  /** Thank-you page. {choice} is the label they clicked. */
  thanks: string; got: string; button: string; invalid: string;
}

const COPY: Record<Lang, Copy> = {
  en: {
    subject: "One click: what should Camberstack get better at?", hi: "Hi,",
    intro: "You've been using Camberstack with your Google accounts. Which of these should it get better at first? One click is your answer, no reply needed.",
    options: { answers: "Answering questions about my ads", conversions: "Checking my conversion tracking", search_terms: "Cleaning up wasted search terms",
      keywords: "Keyword research", reports: "Website traffic and SEO reports", enough: "It already does what I need" },
    bye: "Thanks,", thanks: "Thanks!", got: "Your answer: {choice}. That's all, you can close this page.", button: "Send my answer",
    invalid: "This link isn't valid. Thanks anyway!",
  },
  pt: {
    subject: "Um clique: no que o Camberstack deve melhorar?", hi: "Olá,",
    intro: "Você tem usado o Camberstack com suas contas do Google. Em qual destes ele deve melhorar primeiro? Um clique já é a sua resposta, não precisa responder ao e-mail.",
    options: { answers: "Responder perguntas sobre meus anúncios", conversions: "Verificar meu acompanhamento de conversões", search_terms: "Limpar termos de pesquisa que desperdiçam verba",
      keywords: "Pesquisa de palavras-chave", reports: "Relatórios de tráfego do site e SEO", enough: "Já faz o que eu preciso" },
    bye: "Obrigado,", thanks: "Obrigado!", got: "Sua resposta: {choice}. É só isso, pode fechar esta página.", button: "Enviar minha resposta",
    invalid: "Este link não é válido. Obrigado mesmo assim!",
  },
  es: {
    subject: "Un clic: ¿en qué debería mejorar Camberstack?", hi: "Hola:",
    intro: "Has estado usando Camberstack con tus cuentas de Google. ¿En cuál de estas debería mejorar primero? Un clic es tu respuesta, no hace falta contestar.",
    options: { answers: "Responder preguntas sobre mis anuncios", conversions: "Revisar mi seguimiento de conversiones", search_terms: "Limpiar términos de búsqueda que desperdician presupuesto",
      keywords: "Investigación de palabras clave", reports: "Informes de tráfico web y SEO", enough: "Ya hace lo que necesito" },
    bye: "Gracias,", thanks: "¡Gracias!", got: "Tu respuesta: {choice}. Eso es todo, puedes cerrar esta página.", button: "Enviar mi respuesta",
    invalid: "Este enlace no es válido. ¡Gracias de todos modos!",
  },
  ar: {
    subject: "نقرة واحدة: ما الذي يجب أن يتحسن فيه Camberstack؟", hi: "مرحبًا،",
    intro: "أنت تستخدم Camberstack مع حسابات Google الخاصة بك. في أيٍّ من هذه يجب أن يتحسن أولًا؟ نقرة واحدة هي إجابتك، ولا حاجة إلى الرد على الرسالة.",
    options: { answers: "الإجابة عن أسئلتي حول إعلاناتي", conversions: "التحقق من تتبّع الإحالات الناجحة (التحويلات)", search_terms: "تنظيف عبارات البحث التي تهدر الميزانية",
      keywords: "البحث عن الكلمات الرئيسية", reports: "تقارير زيارات الموقع وتحسين محركات البحث (SEO)", enough: "إنه يفعل ما أحتاجه بالفعل" },
    bye: "شكرًا،", thanks: "شكرًا!", got: "إجابتك: {choice}. هذا كل شيء، يمكنك إغلاق هذه الصفحة.", button: "إرسال إجابتي",
    invalid: "هذا الرابط غير صالح. شكرًا على أي حال!",
  },
  tr: {
    subject: "Tek tık: Camberstack neyi daha iyi yapmalı?", hi: "Merhaba,",
    intro: "Camberstack'i Google hesaplarınızla kullanıyorsunuz. Önce hangisinde daha iyi olmalı? Tek bir tıklama cevabınızdır, e-postayı yanıtlamanıza gerek yok.",
    options: { answers: "Reklamlarımla ilgili soruları yanıtlamak", conversions: "Dönüşüm izlememi kontrol etmek", search_terms: "Bütçeyi boşa harcayan arama terimlerini temizlemek",
      keywords: "Anahtar kelime araştırması", reports: "Web sitesi trafiği ve SEO raporları", enough: "Zaten ihtiyacım olanı yapıyor" },
    bye: "Teşekkürler,", thanks: "Teşekkürler!", got: "Cevabınız: {choice}. Hepsi bu kadar, bu sayfayı kapatabilirsiniz.", button: "Cevabımı gönder",
    invalid: "Bu bağlantı geçerli değil. Yine de teşekkürler!",
  },
  fr: {
    subject: "En un clic : sur quoi Camberstack doit-il progresser ?", hi: "Bonjour,",
    intro: "Vous utilisez Camberstack avec vos comptes Google. Sur quel point doit-il s'améliorer en priorité ? Un clic suffit, inutile de répondre à cet e-mail.",
    options: { answers: "Répondre à mes questions sur mes annonces", conversions: "Vérifier mon suivi des conversions", search_terms: "Nettoyer les termes de recherche qui gaspillent du budget",
      keywords: "Recherche de mots clés", reports: "Rapports sur le trafic du site et le SEO", enough: "Il fait déjà ce dont j'ai besoin" },
    bye: "Merci,", thanks: "Merci !", got: "Votre réponse : {choice}. C'est tout, vous pouvez fermer cette page.", button: "Envoyer ma réponse",
    invalid: "Ce lien n'est pas valide. Merci quand même !",
  },
  de: {
    subject: "Ein Klick: Was soll Camberstack besser machen?", hi: "Hallo,",
    intro: "Sie nutzen Camberstack mit Ihren Google-Konten. Worin soll es zuerst besser werden? Ein Klick ist Ihre Antwort, Sie müssen nicht antworten.",
    options: { answers: "Fragen zu meinen Anzeigen beantworten", conversions: "Mein Conversion-Tracking prüfen", search_terms: "Suchbegriffe bereinigen, die Budget verschwenden",
      keywords: "Keyword-Recherche", reports: "Berichte zu Website-Traffic und SEO", enough: "Es kann schon alles, was ich brauche" },
    bye: "Danke,", thanks: "Danke!", got: "Ihre Antwort: {choice}. Das war's, Sie können diese Seite schließen.", button: "Antwort senden",
    invalid: "Dieser Link ist nicht gültig. Trotzdem danke!",
  },
  zh: {
    subject: "点一下：Camberstack 应该先改进哪方面？", hi: "你好，",
    intro: "你一直在用 Camberstack 连接你的 Google 账号。它应该先在哪方面做得更好？点一下就是你的回答，无需回复邮件。",
    options: { answers: "回答关于我广告的问题", conversions: "检查我的转化跟踪", search_terms: "清理浪费预算的搜索字词",
      keywords: "关键字研究", reports: "网站流量和 SEO 报告", enough: "它已经能满足我的需求" },
    bye: "谢谢，", thanks: "谢谢！", got: "你的回答：{choice}。就这些，你可以关闭此页面。", button: "提交我的回答",
    invalid: "此链接无效。仍然感谢你！",
  },
};

const EN_LINE = "(In English: which should Camberstack get better at first? Click any option above.)";

export const choiceLabel = (c: string, lang: Lang = "en") => COPY[lang].options[c as Choice] ?? c;

export class Survey {
  constructor(private d: { db: DB; baseUrl: string; signingKey: Buffer }) {}

  private sig(userId: string): string { return sign(this.d.signingKey, `survey:${SURVEY_ID}:${userId}`); }

  url(userId: string, lang: Lang, c: Choice): string {
    return `${this.d.baseUrl}/survey?u=${encodeURIComponent(userId)}&c=${c}&l=${lang}&s=${this.sig(userId)}`;
  }

  /** The email for one recipient, in announce.ts's plain-text format, with that recipient's own answer links. */
  email(userId: string, tz: string | null | undefined, lang: Lang = langFor(tz)): { lang: Lang; rtl: boolean; subject: string; body: string } {
    const t = COPY[lang];
    const opts = CHOICES.map((c) => `- [${t.options[c]}](${this.url(userId, lang, c)})`).join("\n");
    const body = [t.hi, t.intro, opts, `${t.bye}\nAdam`, ...(lang === "en" ? [] : [EN_LINE])].join("\n\n");
    return { lang, rtl: lang === "ar", subject: t.subject, body };
  }

  /** Each user's latest answer, counted by choice and by language. */
  results(): { total: number; byChoice: Record<string, number>; byLang: Record<string, number>; clicks: number } {
    const rows = this.d.db.prepare(`SELECT choice, lang FROM survey_answers a WHERE survey = ? AND id = (SELECT max(id) FROM survey_answers b
        WHERE b.survey = a.survey AND b.user_id = a.user_id)`).all(SURVEY_ID) as { choice: string; lang: string }[];
    const byChoice: Record<string, number> = {}, byLang: Record<string, number> = {};
    for (const r of rows) { byChoice[r.choice] = (byChoice[r.choice] ?? 0) + 1; byLang[r.lang] = (byLang[r.lang] ?? 0) + 1; }
    const clicks = (this.d.db.prepare("SELECT count(*) n FROM survey_answers WHERE survey = ?").get(SURVEY_ID) as { n: number }).n;
    return { total: rows.length, byChoice, byLang, clicks };
  }

  mount(app: Express, page: (lang: Lang, title: string, body: string) => string): void {
    const parse = (q: Record<string, unknown>) => {
      const u = String(q.u ?? ""), c = String(q.c ?? ""), l = String(q.l ?? "");
      const lang = (LANGS as readonly string[]).includes(l) ? l as Lang : "en";
      const ok = !!u && (CHOICES as readonly string[]).includes(c) && safeEqual(this.sig(u), String(q.s ?? ""));
      return { u, c: c as Choice, lang, ok };
    };
    const qs = (p: { u: string; c: string; lang: string }, s: unknown) => `u=${encodeURIComponent(p.u)}&c=${p.c}&l=${p.lang}&s=${encodeURIComponent(String(s ?? ""))}`;
    const dir = (lang: Lang, html: string) => lang === "ar" ? `<div dir="rtl">${html}</div>` : html;

    app.get("/survey", (req, res) => {
      const p = parse(req.query as Record<string, unknown>), t = COPY[p.lang];
      res.setHeader("Cache-Control", "no-store");
      if (!p.ok) { res.status(400).type("html").send(page(p.lang, t.thanks, dir(p.lang, `<p>${esc(t.invalid)}</p>`))); return; }
      const got = esc(t.got).replace("{choice}", `<strong>${esc(t.options[p.c])}</strong>`);
      // Recorded by the POST, which the script sends at once; the button is for browsers without JavaScript.
      res.type("html").send(page(p.lang, t.thanks, dir(p.lang, `<form id="answer" method="post" action="/survey?${qs(p, req.query.s)}">
<p>${got}</p><noscript><button class="btn" style="border:0;cursor:pointer">${esc(t.button)}</button></noscript></form>
<script>fetch(document.getElementById("answer").action,{method:"POST"}).catch(function(){});</script>`)));
    });
    app.post("/survey", express.urlencoded({ extended: false, limit: "1kb" }), (req, res) => {
      const p = parse(req.query as Record<string, unknown>), t = COPY[p.lang];
      if (!p.ok) { res.status(400).end(); return; }
      // A link for someone who isn't a user (a test copy) shows the page but records nothing.
      if (this.d.db.prepare("SELECT 1 FROM users WHERE id = ?").get(p.u)) {
        this.d.db.prepare("INSERT INTO survey_answers (survey, user_id, choice, lang, at) VALUES (?, ?, ?, ?, ?)").run(SURVEY_ID, p.u, p.c, p.lang, now());
      }
      const got = esc(t.got).replace("{choice}", `<strong>${esc(t.options[p.c])}</strong>`);
      res.type("html").send(page(p.lang, t.thanks, dir(p.lang, `<p>${got}</p>`)));
    });
  }
}
