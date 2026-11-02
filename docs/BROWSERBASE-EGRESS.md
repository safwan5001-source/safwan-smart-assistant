# ضوابط الخروج الشبكي (Egress) في Browserbase — ما يقوله التوثيق، وما يثبته الكود، وما يبقى غير مُثبَت

**الغرض:** قرار المالك: لا يُغلق F1' ولا يُفعَّل التصفح التفاعلي قبل أن يكون الخروج الشبكي مضبوطًا بسياسة **نفرضها نحن أو يفرضها المزوّد فعليًا**. هذا الملف يجيب: هل يوفّر Browserbase سياسة تسمح بمواقع معتمدة فقط؟ وما حدودها؟

**المصادر (قُرئت كلها من التوثيق الرسمي بتاريخ 2026-11-02؛ لم أعتمد على ملخص بحث دون قراءة الصفحة):**
[allowed domains](https://docs.browserbase.com/platform/browser/security/allowed-domains.md) · [navigation policies](https://docs.browserbase.com/platform/browser/security/navigation-policies.md) · [proxies](https://docs.browserbase.com/platform/identity/proxies.md) · [IP allowlisting / custom proxy](https://docs.browserbase.com/platform/browser/security/ip-allowlisting) · [Create a session (API)](https://docs.browserbase.com/reference/api/create-a-session.md) · [Security guide](https://docs.browserbase.com/guides/security) · [Enterprise security](https://docs.browserbase.com/account/enterprise/security.md)

## 1) ما يقوله التوثيق الرسمي
| الضابط | ما يغطيه (بنصّه) | ما **لا** يغطيه (بنصّه) | التوفّر/ملاحظات |
|---|---|---|---|
| `browserSettings.allowedDomains` | «Browserbase blocks top-level page navigations to any domain not on the list» + النطاقات الفرعية تلقائيًا | «It does not block iframe/subframe loads or in-page resource requests (images, scripts, XHR, etc.)»؛ لا يُطبَّق على `about:blank` و`chrome://` و`file://`؛ HTTP(S) فقط | **تجريبي**: «its behavior may change in future releases»؛ لا قيد خطة مذكور |
| سياسات التنقل `riskPolicyId` | الصفحة العلوية (روابط، إرسال نماذج، `page.goto`)، iframes، النوافذ المنبثقة/`window.open`، `Target.createTarget`، **كل قفزة تحويل** | «A policy doesn't check requests a page makes itself, such as scripts, images, `fetch` and XHR calls, and WebSockets»؛ لا تفحص ما لا يُحمَّل من الشبكة (`about:blank`, `data:`, `blob:`)؛ لا شيء عن Workers؛ Service Workers قد تُجيب تنقلًا دون شبكة | تُفعَّل **لكل مشروع بطلب إلى support@browserbase.com** (حتى ذلك: API يعيد 404 وتُتجاهل `riskPolicyId`)؛ الجلسة المرتبطة بسياسة **لا تنشئ سياقات جديدة** (`Target.createBrowserContext` مرفوض: عاملنا يستعمل السياق الافتراضي فلا مشكلة)؛ 500 تجاوز نطاق كحد أقصى |
| البروكسي الخارجي `proxies:[{type:"external",server,username,password,domainPattern?}]` | توجيه حركة المتصفح عبر وكيل HTTP/HTTPS نملكه؛ التحقق من الاتصال بالوكيل عند إنشاء الجلسة | **لا يحدد التوثيق** أي أنواع الحركة تمر عبره (WebSocket، prerender، preconnect، DNS، UDP/QUIC)؛ «Not all proxy providers are supported»؛ **SOCKS5 غير مدعوم**؛ الحركة التي لا تطابق أي `domainPattern` تذهب مباشرة (مفهوم من المثال) | «Developer Plan or higher»؛ تُحتسب الباندويدث؛ الوكيل يجب أن يكون متاحًا من Browserbase (IP عام أو نفق) |
| أمن المنصة | «Every browser runs in an isolated subnet with strict firewalls to prevent lateral movement»؛ VM مستقل لكل جلسة يُقتل ويُعاد إنشاؤه | **غير موصوف:** تصفية الخروج، الوصول إلى عناوين خاصة/ميتاداتا، DNS | لا شيء عن allow-list للوجهات الخارجية في صفحة الأمان ولا في صفحة المؤسسات؛ تُوجَّه الأسئلة إلى الـTrust Center |

**الخلاصة من التوثيق:** لا يوجد ضابط **موثَّق** يفرض قائمة سماح على **الحركة الفرعية** (صور/سكربتات/XHR/WebSocket/prefetch/DNS). ما يوفره المزوّد يحكم **التنقل العلوي** (و iframes والتحويلات عبر السياسات) فقط. الضابط الوحيد القابل لفرض سياسة وجهات شاملة هو **وكيل خروج نملكه** تُوجَّه إليه الجلسة عبر `proxies`.

## 2) ما أثبتناه محليًا (مصفوفة القنوات — `services/browser/scripts/channel-matrix.mjs`)
تشغيل كل قناة على **الحارس الكامل الحقيقي** (سياسة النطاق + بوابة الآثار + CSP الجلسة) بثلاث طرق تشغيل (والفارق الحاسم هو **ملف المتصفح التنفيذي** لا طريقة الإطلاق)، بمضيفات وهمية مربوطة بخادم محلي (لا شيء يغادر الجهاز، ولا موقع طرف ثالث): [`channel-matrix.md`](verification/chat-browser-2/channel-matrix.md) · [`channel-matrix.json`](verification/chat-browser-2/channel-matrix.json).
- **`chromium.launch()` الافتراضي في Playwright = `chrome-headless-shell`** (ما تستعمله اختبارات المستودع): كل القنوات `stopped`. السبب أن هذا الملف التنفيذي لا ينفّذ prerender ولا preconnect ولا حركة الصيانة، **لا** أن حارسنا يغلقها. لا تُعمَّم هذه النتيجة على متصفح المزوّد.
- **Chrome كامل (الملف التنفيذي الكامل) يُشغَّل مباشرة بمنفذ تصحيح ثم يُتصل به عبر CDP** (أقرب ما نستطيع محاكاته لمتصفح مزوّد؛ **المزوّد قد يستعمل ملفًا مختلفًا**): تتسرب **`<link rel=prerender>`** (GET مع query إلى أي مضيف) و**اتصالات TLS إلى مضيف خارجي** (SNI = اسم المضيف، أي قناة بيانات داخل اسم المضيف) عبر `preconnect` و`meta refresh` و`iframe/object`. ترويستا `Refresh` و`Link` أصبحتا `stopped` لأن الحارس يجرّدهما من ردود المستندات (`sanitizeDocumentHeaders`)؛ الباقي (WebSocket، Worker، beacon وقت الإغلاق، speculation، fetch/XHR، التنزيلات، التحويلات…) `stopped`. DNS-prefetch **لا يُرصد محليًا** (يُفترض أنه يسرّب اسم المضيف إلى المحلّل).
- **Chrome مباشر + وكيل خروج بقائمة سماح (المختبر فقط)**: كل ما سبق `stopped`، وسجل الوكيل يُظهر `CONNECT evil.test:443` وأخواته **مرفوضة قبل أي TLS أو حل DNS من المتصفح** (مع وكيل HTTP يرسل Chrome اسم المضيف للوكيل ولا يحلّه). Chrome نفسه يحاول الاتصال بمضيفات Google للصيانة (ضبط الوقت، التحديثات، الملء التلقائي): تُرفض في الوكيل وتُسجَّل وتُستثنى من أعمدة قنوات الصفحة.

**الدلالة:** لا يمكن إغلاق هذه القنوات من الكود (CSP وCDP Fetch لا يريانها). **وكيل خروج بقائمة سماح يغلقها محليًا.** يبقى الشرط الحاسم: هل تمرّ **كل** حركة جلسة Browserbase عبر الوكيل الخارجي؟ هذا **غير موثَّق** ويتطلب الاختبار الحي الواحد.

## 3) من يفرض ماذا (تمييز صريح)
| الضابط | مثبَت في الكود/الاختبارات | يفرضه المزوّد فعليًا | الحالة |
|---|---|---|---|
| نطاق المختبر (مضيف + بادئة مسار) | ✅ سياسة + API + BFF | — | مثبَت |
| بوابة الآثار (method/نوع المورد/تنقل/جسم النموذج) | ✅ على Chromium الذي يشغّله Playwright **وعلى Chrome المباشر** للقنوات التي تمر بالـroute/Fetch | — | مثبَت محليًا؛ **غير مثبَت على Browserbase** (اعتراض CDP عن بُعد) |
| CSP الجلسة (بلا `unsafe-inline`) | ✅ يغلق وقت-الإغلاق/Workers/Speculation المضمَّنة محليًا | — | مثبَت محليًا؛ **غير مثبَت على Browserbase** |
| تنقل علوي إلى نطاقات غير معتمدة | جزئيًا (حارس الكود) | **وثائقيًا** عبر `allowedDomains` (تجريبي) / `riskPolicyId` (يحتاج تفعيل مشروع) | غير مجرَّب |
| حركة فرعية، WebSocket، prefetch/prerender/preconnect، DNS | ❌ **لا يمكن من الكود** | ❌ **غير موثَّق** عند المزوّد | **مفتوح (F1')** |
| وكيل خروج بقائمة سماح نملكه | ✅ يغلقها محليًا (المصفوفة) | غير موثَّق أنه يشمل كل أنواع الحركة | **يحتاج الاختبار الحي** |
| عدم الوصول لخدمات داخلية/ميتاداتا | سياسة النطاق + الوكيل (مضيف واحد) | «isolated subnet… to prevent lateral movement» (للحركة الجانبية داخل منصتهم؛ لا يذكر الخروج لعناوين خاصة) | يحتاج الاختبار الحي (أهداف محلية خاصة بنا) |

## 4) التصميم المرشح: «وكيل خروج بقائمة سماح» (لم يُنفَّذ ولم يُنشر)
- خدمة صغيرة نملكها (لا تشارك أي شيء مع إنتاج المساعد): وكيل HTTP/HTTPS يقبل `CONNECT <lab-host>:443` **فقط**، يرفض كل ما عداه (ويشمل عناوين IP الخاصة والميتاداتا والمنافذ الأخرى) ويسجّل الرفض، بمصادقة `username/password`، بلا TLS interception، وبحدود معدّل وحجم.
- يُمرَّر من العامل عند إنشاء الجلسة: `proxies:[{type:"external", server, username, password}]` (+ `allowedDomains:[<lab-host>]` كطبقة إضافية للتنقل).
- **فشل مغلق:** إن تعذّر الوكيل فشل إنشاء الجلسة (التوثيق: التحقق عند الإنشاء) ولا يُتصفَّح بلا وكيل.
- **أسئلة لدعم Browserbase (قبل الاختبار الحي أو معه):** (1) هل يمرّ **كل** ما يرسله Chrome (HTTP/HTTPS/WebSocket/prefetch/prerender/preconnect/DNS) عبر الوكيل الخارجي عند عدم تحديد `domainPattern`؟ (2) هل يُعطَّل QUIC/HTTP3 وWebRTC/UDP مع الوكيل؟ (3) كيف يُشغَّل Chrome (الأعلام، `--proxy-server` أم قواعد بروكسي أخرى)؟ (4) هل توجد سياسة allow-list للوجهات على مستوى المنصة (Enterprise)؟ وهل تُحجب العناوين الخاصة/ميتاداتا؟ (5) هل تُطبَّق `allowedDomains`/`riskPolicyId` على التحويلات وعلى `meta refresh`؟

## 5) المخاطر المتبقية (حتى بعد نجاح الاختبار الحي)
اعتماد على سلوك مزوّد غير موثَّق بالكامل؛ الوكيل نقطة فشل وهدف (يجب ألا يكون مرحّلًا مفتوحًا)؛ تكلفة الباندويدث؛ قنوات UDP/WebRTC/QUIC إن لم تُغطَّ؛ حركة Chrome الذاتية (صيانة) تُرفض وقد تُحدث ضجيجًا؛ التوثيق نفسه «تجريبي» لـ`allowedDomains` ويتغير.
