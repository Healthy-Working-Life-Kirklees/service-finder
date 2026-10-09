// Page text in each language, and the language switcher.
//
// To change a translation, edit the text here. Keep the keys the same in every language.
// The Polish and Urdu text is a first draft. Before the wider test, have a qualified translator check it,
// especially the urgent support wording (crisisMh*, crisisMedical, crisisOther, footer*).
//
// The chosen language is kept in the address (?lang=pl or ?lang=ur), not in browser storage, so the page
// still stores nothing. A link with ?lang=ur opens the page in Urdu.
(() => {
  'use strict';

  const LANGS = {
    en: { label: 'English', dir: 'ltr', locale: 'en-GB' },
    pl: { label: 'Polski', dir: 'ltr', locale: 'pl-PL' },
    ur: { label: 'اردو', dir: 'rtl', locale: 'ur-PK' },
  };

  const STRINGS = {
    en: {
      pageTitle: 'Healthy Working Life Support Finder (prototype)',
      skip: 'Skip to the message box',
      langNav: 'Language',
      siteName: 'Healthy Working Life Support Finder',
      eyebrow: 'Welcome to Healthy Working Life Support Finder',
      introHeading: 'Describe a person’s situation to find relevant employment and health support services.',
      noticeStrong: 'Prototype for testing.',
      noticeRest: 'The service details come from the Healthy Working Life scheme pathways document and may be out of date. Always check with the service before referring.',
      heroTitle: 'How can we help this person?',
      heroText: "Please describe the person's situation: approximate age, location, employment situation, health or wellbeing needs, and what they hope to achieve. Please do not include names or any personally identifiable information.",
      logLabel: 'Conversation',
      modeLegend: 'Who is this for?',
      modeSelf: "I'm looking for support for myself",
      modeStaff: "I'm helping someone else (staff or partner)",
      messageLabel: "Describe the person's situation",
      placeholder: 'Example: A 45-year-old in Kirklees, currently unemployed, struggling with low mood and looking for local support groups or activities to help improve their wellbeing...',
      send: 'Find support',
      sending: 'Looking...',
      reset: 'Start again',
      chipsLabel: 'Example questions',
      chips: [
        "I've been off sick with back pain and want to get back to work",
        "I'm 20, not in work or education, and struggling with anxiety",
        'I support a client with a learning disability who wants a job',
        'I manage a small team and some of them are carers',
      ],
      privacy: "Please don't type names, addresses, dates of birth or NHS numbers. Your messages are passed through a Cloudflare service to Claude, an AI service from Anthropic, to find matches. This prototype does not save them, and the conversation is gone when you close or refresh the page.",
      footerStrong: 'In an emergency call 999.',
      footerA: 'For urgent mental health support in Kirklees, call the 24-hour Single Point of Access team on ',
      footerB: ' or call NHS 111.',

      fitStrong: 'Strong match',
      fitPossible: 'Worth checking',
      open: 'Open to referrals',
      notOpen: 'Not open yet',
      selfYes: 'You can refer yourself',
      selfPartly: 'Self-referral with a link from a professional',
      selfTbc: 'Self-referral: to be confirmed',
      age: 'Age: ',
      phone: 'Phone: ',
      email: 'Email: ',
      website: 'Website: ',
      webpageLink: 'service web page',
      noContact: 'No contact details are listed yet. Please check with the Healthy Working Life team.',
      onlineForm: 'Online form',
      checkFirst: 'Check first: ',
      contact: 'Contact',
      howIn: 'How to get in',
      whoJoin: 'Who can join',
      whoNot: 'Who it is not for',
      whatWhere: 'What happens and where',
      where: 'Where',
      lastChecked: 'Information last checked: {date}.',
      stale: 'This entry is overdue a check, so please confirm the details with the service first.',
      copy: 'Copy details',
      copied: 'Copied',
      copyFailed: "Couldn't copy",
      copyConfirm: 'Please confirm with the service before referring.',
      crisisMhA: 'If you or someone else is in immediate danger, call 999. For urgent mental health support in Kirklees, call the 24-hour Single Point of Access team on ',
      crisisMhB: ' or call NHS 111.',
      crisisMedical: 'If this is a medical emergency, call 999. If it is urgent but not an emergency, call NHS 111.',
      crisisOther: 'If someone is in immediate danger, call 999. If it is not an emergency, speak to your GP or call NHS 111 for help finding the right support.',
      thinking: 'Looking through the services...',
      notConnected: 'The AI service has not been connected to this page yet.',
      generic: 'Something went wrong. Please try again.',
      network: 'Could not reach the service. Please check your connection and try again.',
      loadFailed: 'Could not load the service information. Please refresh the page.',
      rateLimited: 'You are sending messages quite quickly. Please wait a minute and try again.',
      busy: 'The service is busy or has reached its daily limit. Please try again later.',
      understood: 'What I have understood so far: ',
      pii: "Please don't type names, addresses, dates of birth or NHS numbers. You don't need to share them to get matches.",
      listSep: '; ',
      end: '.',
    },

    pl: {
      pageTitle: 'Healthy Working Life – wyszukiwarka wsparcia (wersja testowa)',
      skip: 'Przejdź do pola wiadomości',
      langNav: 'Język',
      siteName: 'Healthy Working Life – wyszukiwarka wsparcia',
      eyebrow: 'Witamy w wyszukiwarce wsparcia Healthy Working Life',
      introHeading: 'Opisz sytuację danej osoby, aby znaleźć odpowiednie usługi wsparcia w zakresie pracy i zdrowia.',
      noticeStrong: 'Wersja testowa.',
      noticeRest: 'Informacje o usługach pochodzą z dokumentu opisującego ścieżki programu Healthy Working Life i mogą być nieaktualne. Przed skierowaniem kogokolwiek zawsze potwierdź je bezpośrednio z daną usługą.',
      heroTitle: 'Jak możemy pomóc tej osobie?',
      heroText: 'Opisz sytuację tej osoby: przybliżony wiek, miejsce zamieszkania, sytuację zawodową, potrzeby związane ze zdrowiem lub samopoczuciem oraz to, co chce osiągnąć. Prosimy nie podawać imion i nazwisk ani żadnych danych, które pozwalają kogoś zidentyfikować.',
      logLabel: 'Rozmowa',
      modeLegend: 'Dla kogo jest to wsparcie?',
      modeSelf: 'Szukam wsparcia dla siebie',
      modeStaff: 'Pomagam komuś innemu (pracownik lub partner)',
      messageLabel: 'Opisz sytuację tej osoby',
      placeholder: 'Przykład: osoba w wieku 45 lat z Kirklees, obecnie bez pracy, zmaga się z obniżonym nastrojem i szuka lokalnych grup wsparcia lub zajęć, które pomogą poprawić samopoczucie...',
      send: 'Znajdź wsparcie',
      sending: 'Szukam...',
      reset: 'Zacznij od nowa',
      chipsLabel: 'Przykładowe pytania',
      chips: [
        'Jestem na zwolnieniu lekarskim z powodu bólu pleców i chcę wrócić do pracy',
        'Mam 20 lat, nie pracuję ani się nie uczę i zmagam się z lękiem',
        'Wspieram osobę z niepełnosprawnością intelektualną, która chce znaleźć pracę',
        'Kieruję małym zespołem i niektórzy z jego członków opiekują się bliskimi',
      ],
      privacy: 'Prosimy nie wpisywać imion i nazwisk, adresów, dat urodzenia ani numerów NHS. Twoje wiadomości są przesyłane przez usługę Cloudflare do Claude, usługi AI firmy Anthropic, w celu znalezienia dopasowań. Ta wersja testowa ich nie zapisuje, a rozmowa znika po zamknięciu lub odświeżeniu strony.',
      footerStrong: 'W nagłym przypadku zadzwoń pod numer 999.',
      footerA: 'Aby uzyskać pilne wsparcie w zakresie zdrowia psychicznego w Kirklees, zadzwoń do całodobowego zespołu Single Point of Access pod numer ',
      footerB: ' lub pod numer NHS 111.',

      fitStrong: 'Dobre dopasowanie',
      fitPossible: 'Warto sprawdzić',
      open: 'Przyjmuje skierowania',
      notOpen: 'Jeszcze nie przyjmuje skierowań',
      selfYes: 'Możesz zgłosić się bezpośrednio',
      selfPartly: 'Samodzielne zgłoszenie z linkiem od specjalisty',
      selfTbc: 'Samodzielne zgłoszenie: do potwierdzenia',
      age: 'Wiek: ',
      phone: 'Telefon: ',
      email: 'E-mail: ',
      website: 'Strona internetowa: ',
      webpageLink: 'strona usługi',
      noContact: 'Nie podano jeszcze danych kontaktowych. Skontaktuj się z zespołem Healthy Working Life.',
      onlineForm: 'Formularz online',
      checkFirst: 'Najpierw sprawdź: ',
      contact: 'Kontakt',
      howIn: 'Jak się zgłosić',
      whoJoin: 'Kto może dołączyć',
      whoNot: 'Dla kogo to nie jest',
      whatWhere: 'Co się odbywa i gdzie',
      where: 'Gdzie',
      lastChecked: 'Informacje ostatnio sprawdzono: {date}.',
      stale: 'Ten wpis wymaga ponownego sprawdzenia, więc najpierw potwierdź szczegóły bezpośrednio z usługą.',
      copy: 'Kopiuj szczegóły',
      copied: 'Skopiowano',
      copyFailed: 'Nie udało się skopiować',
      copyConfirm: 'Przed skierowaniem potwierdź informacje z usługą.',
      crisisMhA: 'Jeśli Ty lub ktoś inny jest w bezpośrednim niebezpieczeństwie, zadzwoń pod numer 999. Aby uzyskać pilne wsparcie w zakresie zdrowia psychicznego w Kirklees, zadzwoń do całodobowego zespołu Single Point of Access pod numer ',
      crisisMhB: ' lub pod numer NHS 111.',
      crisisMedical: 'W nagłym przypadku medycznym zadzwoń pod numer 999. Jeśli sprawa jest pilna, ale nie jest nagłym przypadkiem, zadzwoń pod numer NHS 111.',
      crisisOther: 'Jeśli ktoś jest w bezpośrednim niebezpieczeństwie, zadzwoń pod numer 999. Jeśli to nie jest nagły przypadek, porozmawiaj ze swoim lekarzem rodzinnym (GP) lub zadzwoń pod numer NHS 111, aby uzyskać pomoc w znalezieniu odpowiedniego wsparcia.',
      thinking: 'Przeszukuję usługi...',
      notConnected: 'Usługa AI nie została jeszcze podłączona do tej strony.',
      generic: 'Coś poszło nie tak. Spróbuj ponownie.',
      network: 'Nie udało się połączyć z usługą. Sprawdź połączenie z internetem i spróbuj ponownie.',
      loadFailed: 'Nie udało się wczytać informacji o usługach. Odśwież stronę.',
      rateLimited: 'Wysyłasz wiadomości dość szybko. Odczekaj minutę i spróbuj ponownie.',
      busy: 'Usługa jest teraz zajęta lub osiągnęła dzienny limit. Spróbuj ponownie później.',
      understood: 'Co udało się ustalić do tej pory: ',
      pii: 'Prosimy nie wpisywać imion i nazwisk, adresów, dat urodzenia ani numerów NHS. Nie są potrzebne do znalezienia dopasowań.',
      listSep: '; ',
      end: '.',
    },

    ur: {
      pageTitle: 'ہیلدی ورکنگ لائف – مدد کی تلاش (آزمائشی ورژن)',
      skip: 'پیغام کے خانے پر جائیں',
      langNav: 'زبان',
      siteName: 'ہیلدی ورکنگ لائف – مدد کی تلاش',
      eyebrow: 'ہیلدی ورکنگ لائف کی مدد کی تلاش میں خوش آمدید',
      introHeading: 'کسی شخص کی صورتحال بیان کریں تاکہ روزگار اور صحت سے متعلق مدد کی مناسب سروسز تلاش کی جا سکیں۔',
      noticeStrong: 'یہ آزمائشی ورژن ہے۔',
      noticeRest: 'سروسز کی تفصیلات ہیلدی ورکنگ لائف اسکیم کی پاتھ ویز دستاویز سے لی گئی ہیں اور ممکن ہے پرانی ہوں۔ کسی کو ریفر کرنے سے پہلے ہمیشہ سروس سے تصدیق کر لیں۔',
      heroTitle: 'ہم اس شخص کی کیسے مدد کر سکتے ہیں؟',
      heroText: 'براہِ کرم اس شخص کی صورتحال بیان کریں: اندازاً عمر، علاقہ، روزگار کی صورتحال، صحت یا بہبود سے متعلق ضروریات، اور وہ کیا حاصل کرنا چاہتے ہیں۔ براہِ کرم نام یا ایسی کوئی معلومات نہ لکھیں جس سے کسی کی شناخت ہو سکے۔',
      logLabel: 'بات چیت',
      modeLegend: 'یہ مدد کس کے لیے ہے؟',
      modeSelf: 'مجھے اپنے لیے مدد چاہیے',
      modeStaff: 'یہ کسی اور کے لیے ہے (عملہ یا پارٹنر)',
      messageLabel: 'اس شخص کی صورتحال بیان کریں',
      placeholder: 'مثال: کرکلیز میں رہنے والا ایک 45 سالہ شخص، جو اس وقت بے روزگار ہے، اداسی کا شکار ہے اور اپنی بہبود بہتر بنانے کے لیے مقامی سپورٹ گروپس یا سرگرمیاں تلاش کر رہا ہے...',
      send: 'مدد تلاش کریں',
      sending: 'تلاش جاری ہے...',
      reset: 'دوبارہ شروع کریں',
      chipsLabel: 'مثالی سوالات',
      chips: [
        'میں کمر درد کی وجہ سے بیماری کی چھٹی پر ہوں اور میری خواہش ہے کہ کام پر واپس جاؤں',
        'میری عمر 20 سال ہے، نہ نوکری ہے نہ پڑھائی، اور اینگزائٹی (بے چینی) کا سامنا ہے',
        'لرننگ ڈس ایبلٹی والے میرے ایک کلائنٹ نوکری کرنا چاہتے ہیں',
        'میں ایک چھوٹی ٹیم کا مینیجر ہوں اور ان میں سے کچھ لوگ کیئرر (دیکھ بھال کرنے والے) ہیں',
      ],
      privacy: 'براہِ کرم نام، پتے، تاریخِ پیدائش یا NHS نمبر نہ لکھیں۔ مناسب سروسز تلاش کرنے کے لیے آپ کے پیغامات Cloudflare کی ایک سروس کے ذریعے Anthropic کی AI سروس Claude کو بھیجے جاتے ہیں۔ یہ آزمائشی ورژن انہیں محفوظ نہیں کرتا، اور صفحہ بند یا ریفریش کرنے پر بات چیت ختم ہو جاتی ہے۔',
      footerStrong: 'ایمرجنسی میں 999 پر کال کریں۔',
      footerA: 'کرکلیز میں ذہنی صحت کی فوری مدد کے لیے 24 گھنٹے کام کرنے والی Single Point of Access ٹیم کو ',
      footerB: ' پر کال کریں، یا NHS 111 پر کال کریں۔',

      fitStrong: 'اچھا میچ',
      fitPossible: 'دیکھنے کے قابل',
      open: 'ریفرل قبول کر رہی ہے',
      notOpen: 'ابھی شروع نہیں ہوئی',
      selfYes: 'آپ خود رجوع کر سکتے ہیں',
      selfPartly: 'کسی پروفیشنل کے لنک کے ساتھ خود رجوع',
      selfTbc: 'خود رجوع: تصدیق ابھی باقی ہے',
      age: 'عمر: ',
      phone: 'فون: ',
      email: 'ای میل: ',
      website: 'ویب سائٹ: ',
      webpageLink: 'سروس کا ویب صفحہ',
      noContact: 'ابھی رابطے کی کوئی تفصیلات درج نہیں ہیں۔ براہِ کرم ہیلدی ورکنگ لائف ٹیم سے معلوم کریں۔',
      onlineForm: 'آن لائن فارم',
      checkFirst: 'پہلے یہ معلوم کریں: ',
      contact: 'رابطہ',
      howIn: 'شامل ہونے کا طریقہ',
      whoJoin: 'کون شامل ہو سکتا ہے',
      whoNot: 'یہ کس کے لیے نہیں ہے',
      whatWhere: 'کیا ہوتا ہے اور کہاں',
      where: 'کہاں',
      lastChecked: 'معلومات کی آخری بار جانچ: {date}۔',
      stale: 'اس اندراج کی جانچ کا وقت گزر چکا ہے، اس لیے براہِ کرم پہلے سروس سے تفصیلات کی تصدیق کر لیں۔',
      copy: 'تفصیلات کاپی کریں',
      copied: 'کاپی ہو گیا',
      copyFailed: 'کاپی نہیں ہو سکا',
      copyConfirm: 'ریفر کرنے سے پہلے براہِ کرم سروس سے تصدیق کر لیں۔',
      crisisMhA: 'اگر آپ یا کوئی اور فوری خطرے میں ہے تو 999 پر کال کریں۔ کرکلیز میں ذہنی صحت کی فوری مدد کے لیے 24 گھنٹے کام کرنے والی Single Point of Access ٹیم کو ',
      crisisMhB: ' پر کال کریں، یا NHS 111 پر کال کریں۔',
      crisisMedical: 'اگر یہ طبی ایمرجنسی ہے تو 999 پر کال کریں۔ اگر معاملہ فوری ہے لیکن ایمرجنسی نہیں، تو NHS 111 پر کال کریں۔',
      crisisOther: 'اگر کوئی فوری خطرے میں ہے تو 999 پر کال کریں۔ اگر ایمرجنسی نہیں ہے تو اپنے GP (فیملی ڈاکٹر) سے بات کریں، یا مناسب مدد تلاش کرنے کے لیے NHS 111 پر کال کریں۔',
      thinking: 'سروسز میں تلاش کی جا رہی ہے...',
      notConnected: 'AI سروس ابھی اس صفحے سے منسلک نہیں کی گئی۔',
      generic: 'کچھ غلط ہو گیا۔ براہِ کرم دوبارہ کوشش کریں۔',
      network: 'سروس سے رابطہ نہیں ہو سکا۔ براہِ کرم اپنا انٹرنیٹ کنکشن چیک کریں اور دوبارہ کوشش کریں۔',
      loadFailed: 'سروسز کی معلومات لوڈ نہیں ہو سکیں۔ براہِ کرم صفحہ ریفریش کریں۔',
      rateLimited: 'آپ بہت جلدی جلدی پیغامات بھیج رہے ہیں۔ براہِ کرم ایک منٹ انتظار کریں اور دوبارہ کوشش کریں۔',
      busy: 'سروس اس وقت مصروف ہے یا آج کی حد پوری ہو چکی ہے۔ براہِ کرم بعد میں دوبارہ کوشش کریں۔',
      understood: 'اب تک ہم نے یہ سمجھا ہے: ',
      pii: 'براہِ کرم نام، پتے، تاریخِ پیدائش یا NHS نمبر نہ لکھیں۔ مناسب سروسز تلاش کرنے کے لیے ان کی ضرورت نہیں۔',
      listSep: '؛ ',
      end: '۔',
    },
  };

  const fromUrl = new URLSearchParams(location.search).get('lang');
  let current = LANGS[fromUrl] ? fromUrl : 'en';
  const listeners = [];

  function t(key, vars) {
    const v = key in STRINGS[current] ? STRINGS[current][key] : STRINGS.en[key];
    if (typeof v !== 'string' || !vars) return v;
    return v.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : ''));
  }

  // Fill in every element marked with data-i18n (text), data-i18n-placeholder or data-i18n-label (aria-label).
  function applyStatic() {
    const info = LANGS[current];
    document.documentElement.lang = current === 'en' ? 'en-GB' : current;
    document.documentElement.dir = info.dir;
    document.title = t('pageTitle');
    for (const n of document.querySelectorAll('[data-i18n]')) n.textContent = t(n.dataset.i18n);
    for (const n of document.querySelectorAll('[data-i18n-placeholder]')) n.placeholder = t(n.dataset.i18nPlaceholder);
    for (const n of document.querySelectorAll('[data-i18n-label]')) n.setAttribute('aria-label', t(n.dataset.i18nLabel));
    for (const b of document.querySelectorAll('.lang-switch button')) b.setAttribute('aria-pressed', String(b.dataset.lang === current));
  }

  function set(lang) {
    if (!LANGS[lang] || lang === current) return;
    current = lang;
    const url = new URL(location.href);
    if (lang === 'en') url.searchParams.delete('lang');
    else url.searchParams.set('lang', lang);
    history.replaceState(null, '', url);
    applyStatic();
    for (const fn of listeners) fn(lang);
  }

  function buildSwitcher() {
    const nav = document.querySelector('.lang-switch');
    if (!nav) return;
    for (const [code, info] of Object.entries(LANGS)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.lang = code;
      b.dir = info.dir;
      b.dataset.lang = code;
      b.textContent = info.label;
      b.addEventListener('click', () => set(code));
      nav.append(b);
    }
  }

  window.I18N = {
    t,
    set,
    get lang() { return current; },
    get locale() { return LANGS[current].locale; },
    onChange: (fn) => listeners.push(fn),
  };

  buildSwitcher();
  applyStatic();
})();
