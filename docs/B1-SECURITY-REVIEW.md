# B1 — المراجعة الأمنية لنواة الجلسات وRLS (المنقولة من Phase 5)

المصدر: فرع `feat/phase-5-secure-account-foundation` (PR #10، @`f2aa584`). **لم يُدمج الفرع**؛ نُقلت أجزاء محددة بعد قراءتها ومراجعتها، وعُدّل ما يلزم.

## 1. ما قُرئ وما نُقل
| ملف Phase 5 | القرار | أين الآن |
|---|---|---|
| `session_secrets.py` | نُقل **بتعديل** | `app/auth/sessions.py` (`issue_secret`, `digest_secret`) |
| `session_resolver.py` + `session_repository.py` | نُقل **بتعديل** (التحقق في قاعدة البيانات) | `auth_resolve_session()` في `0001_core.sql` + `resolve_session` |
| `owner_scope.py` | نُقل **بتعديل** | `app/db/scope.py` |
| `phase5_preview_consolidated.sql` (accounts/sessions/sync_records) | نُقل **بتعديل** | `migrations/0001_core.sql`, `0002_tenant_data.sql` |
| `phase5_postgres_rls_ci.sql` + `phase5_postgres_sessions_ci.sql` | حُوّلا إلى اختبارات pytest **أقوى** | `tests/test_rls_isolation.py`, `tests/test_sessions_db.py` |
| `auth_config.py`, `preview_csrf.py`, `password_credentials.py`, `login_throttle.py`, `preview_login_http.py`, `preview_session_http.py` | **مؤجَّل إلى B2** (مصادقة الدخول) | — |
| `main.py`, `vercel.json` (Phase 5), `network_throttle.py`, `neon_probe.py`, `preview_readiness.py` | **لا يُنقل** | — |
| `email_verification*`, `account_*`, `registration_contracts`, `session_issuer` | لم تُقرأ بالتفصيل؛ خارج نطاق B1 | — |

## 2. ثغرات/ضعف وُجدت في Phase 5 وكيف عولجت
| # | الملاحظة (حقيقة من قراءة الكود) | المعالجة في B1 | اختبار |
|---|---|---|---|
| 1 | جدولا `accounts` و`sessions` **بلا RLS** إطلاقاً؛ RLS على `sync_records` فقط | RLS مفعّل عليهما + سياسات `TO safwan_app` | `test_rls_isolation`, `test_sessions_db` |
| 2 | اختبار الجلسات في CI (`phase5_postgres_sessions_ci.sql`) يعمل بصلاحيات **المالك/superuser** فلا يثبت العزل | كل اختبارات B1 تعمل عبر `SET ROLE safwan_app` مع تحقق أنه ليس superuser ولا BYPASSRLS | `runtime_connection()` |
| 3 | لا دور تشغيل محدد في المخطط (يُنشأ داخل اختبار CI فقط) | `safwan_app` يُنشأ بالترحيل: `NOSUPERUSER NOBYPASSRLS` وصلاحيات أعمدة دنيا | `test_schema_security_properties` |
| 4 | الانتهاء يُقرَّر بساعة التطبيق (`datetime.now`) مقابل `now()` في SQL | ساعة قاعدة البيانات وحدها داخل `auth_resolve_session` | `test_expired_session_is_rejected_by_the_database_clock` |
| 5 | حد أقصى لعمر الجلسة 7 أيام (لا يتيح «تذكرني» 30 يوماً) | 7 أيام افتراضياً، 30 لـ«تذكرني»؛ قيد SQL `<= 31 يوماً` | `test_default_and_remember_lifetimes`, `test_lifetime_over_31_days...` |
| 6 | البحث عن الجلسة قبل معرفة الحساب لا يمكن أن يمر بـ RLS | دالة وحيدة `SECURITY DEFINER` بـ `search_path` مثبّت وبلا PUBLIC execute، تجيب فقط «من صاحب هذا التجزئة؟» | `test_schema_security_properties` |
| 7 | الجلسة قابلة للتعديل بأي عمود | `GRANT UPDATE (revoked_at, last_seen_at)` فقط | `test_session_rows_are_immutable...` |
| 8 | لا فحص لإنشاء جلسة لحساب آخر | `WITH CHECK` + اختبار طفرة يكشف حذفه | `test_a_scoped_caller_cannot_mint...` |
| 9 | `sync_records` يسمح بـ DELETE نظرياً | لا DELETE (tombstone)؛ `audit_log` للإلحاق فقط | `test_application_role_cannot_delete...`, `test_audit_log_is_append_only...` |
| 10 | الأسرار غير مقيَّدة الشكل | يُرفض أي سر غير `token_urlsafe(32)` (43 حرفاً) **قبل** أي استعلام | `test_malformed_secrets_never_reach_the_database` |
| 11 | `csrf_proof` يستخدم وسماً خاصاً بالخروج (`safwan:logout:csrf:v1`) | مؤجَّل لـ B2 مع تعميمه | — |
| 12 | الاتصال لكل طلب بلا مهلة بيان | `statement_timeout` محلي للمعاملة (5ث افتراضياً) | `owner_transaction` |
| 14 | (مراجعة Codex، P1) دالتا `SECURITY DEFINER` بلا `pg_temp` صريح: PostgreSQL يبحث في المخطط المؤقت **أولاً** عن الجداول، فيستطيع دور التشغيل (يملك TEMP افتراضياً) إنشاء `sessions`/`accounts`/`service_nonces` مؤقتة تستخدمها دالة بصلاحيات المالك — **أثبتُّ عملياً** أن جدولاً مؤقتاً مزيّفاً كان يجعل `auth_resolve_session` تُرجع حساب الضحية | `search_path = pg_catalog, public, pg_temp` + تأهيل كل الجداول بـ `public.` | `tests/test_definer_hardening.py` (5 اختبارات: تزوير جلسة، التقاط nonce، trigger بصلاحيات المالك، تثبيت المسار، فحص الأسماء المؤهلة) |
| 13 | (اكتُشف أثناء B1) ترحيل 0001 يفشل مع مالك **غير superuser** كما في Neon: `ALTER ROLE … NOSUPERUSER` مرفوض | الترحيل **يتحقق** من أن `safwan_app` غير مميّز ويرفض المتابعة بدل تعديله | `test_migrations_run_as_a_non_superuser_owner`, `test_a_preexisting_overprivileged...` |

**اختبارات الطفرات (تحقق أن الاختبارات تكشف الخلل):** أُفسدت ثلاث مرات مؤقتاً — `USING (true)` على `sync_records` (فشل 8 اختبارات)، `WITH CHECK (true)` على `sessions` (كُشف بعد إضافة اختبار #8؛ **لم يكن مكشوفاً قبل ذلك**)، وتجاهل `revoked_at` (فشل اختباران) — ثم أُعيدت الملفات كما كانت.

## 3. إثبات الخدمة-إلى-الخدمة (BFF → API)
**التهديد:** Service Binding في Vercel يمنح *قابلية الوصول* ولا يوثّق المتصل، ويتجاوز Firewall وDeployment Protection (وثائق Vercel، 2026-10-31).
**الضوابط (`app/service_auth.py` ⇄ `apps/web/server/*`):**
- HMAC-SHA256 على سلسلة معيارية: سياق الإصدار + الطريقة + المسار والاستعلام + الطابع الزمني + nonce + SHA-256 للجسم + معرّف الحساب. أي تغيير في أي عنصر يُبطل التوقيع.
- نافذة ±60ث؛ nonce لمرة واحدة في **PostgreSQL** (مشترك بين النسخ، `INSERT … ON CONFLICT`، اختبار تزامن 24 طلباً → فائز واحد)؛ يُستهلك **بعد** نجاح التوقيع فقط (لا تضخيم كتابة لغير الموثَّقين).
- فشل مغلق: سر ناقص/أقل من 32 بايت → 503؛ لا مخزن nonce → 503؛ الإنتاج لا يقبل مخزن الذاكرة أبداً؛ **دور قاعدة بيانات مميّز في الإنتاج → رفض** (`OverPrivilegedRole`): superuser، BYPASSRLS، CREATEROLE/CREATEDB/REPLICATION، **أو مالك (مباشر أو بالوراثة) لأي جدول في التطبيق** — وهو الدور الافتراضي في Postgres المُدار وغير superuser لكنه يتجاوز RLS على الجداول بلا FORCE (ملاحظة مراجعة Codex؛ اختبار `test_nonsuperuser_owner.py`)؛ `DATABASE_URL` (الذي تحقنه تكاملات Postgres بدور المالك) **يُتجاهل** عمداً لصالح `APP_DATABASE_URL`.
- **الحداثة تُفحص مرتين**: عند وصول الترويسات **وقبل حجز الـ nonce مباشرةً** (بعد قراءة الجسم)، وقراءة الجسم لها مهلة 10ث (408) وحد 1MiB أثناء البث؛ وإلا أمكن لطلب ملتقَط بجسم بطيء أن يتجاوز مدة احتفاظ الـ nonce فيُقبل مرتين (مراجعة Codex، اختبار يعيد إنتاجه).
- ردّ موحّد `401 service_auth_failed` لكل أنواع الفشل (لا oracle)؛ السبب في السجل فقط وبلا أسرار (اختبار caplog).
- دعم تدوير المفتاح (`SERVICE_AUTH_SECRET_PREVIOUS`)، مقارنة ثابتة الزمن مع كل المفاتيح دون short-circuit.
- العقد مُثبَّت بمتجهات مشتركة (`shared/service-signature-vectors.json`) تتحقق منها اختبارات Python وTypeScript.
- جانب Next: المسار ثابت `/internal/v1/*` ولا يُشتق من طلب المتصفح، لا يتبع التحويلات، حد حجم وزمن، ولا يُعيد أسراراً أو عناوين. مسار `/api/health` للقراءة فقط.

## 4. مخاطر متبقية (صريحة)
1. **Service Binding نفسه لم يُثبت على Vercel** — هذا خارج ما أستطيع التحقق منه؛ انظر `docs/B1-PREVIEW-CHECKLIST.md`. افتراض غير مُتحقَّق: المسار الذي يستلمه FastAPI عبر الـ binding هو `/internal/v1/ping` كما أُرسل؛ إن أضافت المنصة بادئة فسيفشل التوقيع (503/rejected، فشل مغلق وليس ثغرة) ويُعالج بإعداد بادئة بعد المعاينة.
2. التوقيع يحمي من المزوّر والمُعيد، **لا** من تسرّب `SERVICE_AUTH_SECRET` نفسه (تدوير ومتغير حساس في Vercel).
3. `/api/health` عام بلا تحديد معدّل (يكلّف نداء داخلياً + عملية nonce واحدة لكل طلب). يُقيَّد في B2 بحد معدّل للتطبيق/Firewall.
4. لا تجميع اتصالات (pool) بعد: اتصال لكل نداء (مقبول لـ B1؛ يلزم عند الحمل أو مع Neon pooler — `set_config(…, true)` محلي للمعاملة فيعمل مع pooling على مستوى المعاملة، **لم يُجرَّب على Neon** ❓).
5. بيانات اعتماد القاعدة (دورا المالك/التشغيل) تُنشأ وتُحفظ يدوياً خارج المستودع (إجراء خارجي).
6. `accounts` تُنشأ حالياً بمسار المالك فقط؛ مسار الإعداد الأول (bootstrap) في B2.
7. الساعة: تعتمد النافذة ±60ث على ساعتي الخدمتين (NTP على Vercel)؛ فرق أكبر يفشل مغلقاً.

## 5. مراجعة ثانية (2026-10-31) — ملاحظات مؤكدة وإصلاحها

المنهج: قراءة ساكنة + مراجعة مستقلة بوكيل لم يُعطَ الاستنتاجات + **تحقق عملي من كل ادعاء قبل اعتماده** على PostgreSQL 16.15 حقيقي. ما لم يتكرر عمليًا لم يُعتمد.

| # | الملاحظة (مؤكدة) | الخطورة | الإصلاح | الاختبار (يفشل دون الإصلاح) |
|---|---|---|---|---|
| 15 | **تداخل `owner_transaction`**: PostgreSQL يُبقي قيم `set_config(…, true)` بعد `RELEASE SAVEPOINT`، فبعد `outer(B){ inner(A) }` يبقى النطاق **A** داخل كتلة B. أُثبت عمليًا. يهم خصوصًا Worker يعالج وظائف حسابات متعددة | منخفضة اليوم (لا مستدعٍ متداخل)، **عالية للـ Worker** | `app/db/scope.py`: عند التداخل تُقرأ القيم السابقة (`app.account_id` و`statement_timeout`) وتُعاد بعد الخروج الطبيعي من الكتلة الداخلية؛ عند الاستثناء يتولى rollback الـ savepoint الاسترجاع. الاستدعاء غير المتداخل لم يتغير | `tests/test_scope_nesting.py` (9): استعادة المستوى الخارجي، ثلاثة مستويات، الاستثناء والمتابعة، عدم تسرب النطاق بعد الخروج، منع الكتابة عبر حسابين بعد الكتلة الداخلية، `statement_timeout`، نطاق داخلي غير صالح، تتابع مستقل، حلقة بأسلوب Worker. 5 من 9 تفشل على الكود السابق |
| 16 | **`revoked_at` قابل للإرجاع إلى NULL** من الدور التشغيلي (منحة UPDATE على العمود) | منخفضة (يلزم اختراق سياق حساب) | ترحيل `0003`: trigger `BEFORE UPDATE OF revoked_at` يمنع أي تغيير بعد وضع القيمة، لكل الأدوار بما فيها المالك؛ `last_seen_at` يبقى قابلًا للتحديث والإبطال المتكرر no-op | `tests/test_hardening_0003.py`: لا إرجاع من الدور التشغيلي ولا نقل التاريخ ولا من المالك، إبطال مكرر، `last_seen_at` على جلسة مبطلة، إبطال جلسة نشطة مرة واحدة |
| 17 | **`public` ضمن `search_path` لدوال `SECURITY DEFINER`**: دالة `public.make_interval(secs integer)` تتقدم على `pg_catalog.make_interval(secs double precision)` لوسيط integer (أُثبتت الآلية) | منخفضة (تقوية): على PG15+ لا يملك الدور CREATE على `public` (أُثبت: `permission denied`) لكن PG14 وما قبله يمنحه لـ PUBLIC، وأي GRANT لاحق يعيد الثغرة | `0003`: `search_path = pg_catalog, pg_temp` للدالتين، كل المستدعيات مؤهلة (`pg_catalog.now/octet_length/make_interval` مع cast إلى double)، `REVOKE CREATE ON SCHEMA public` من PUBLIC و`safwan_app` | نفس الملف: المسار بالضبط، محاكاة دالة ظل يضعها المالك لا تغيّر مدة الـ nonce، لا CREATE لـ PUBLIC/التطبيق |
| 18 | **500 بدل الرد الموحّد** عند ترويسة `x-svc-ts` بحرف Latin-1 مثل `²` (بايت 0xB2): `str.isdigit()` صحيحة له، ثم `int()` ترفع `ValueError`. أُثبت **على خادم uvicorn حقيقي بطلب خام** (500 مقابل 401 للحالة الصحيحة). كما أن `re.match(...$)` يقبل `\n` أخيرًا في nonce والتوقيع وسر الجلسة | منخفضة (طلب غير موثَّق، يكشف فرقًا بين 500 و401 ويضخّم الضجيج) | `service_auth.py`: `_TS_RE = [0-9]{1,12}` و`fullmatch` لكل من الترويسات الثلاث؛ `sessions.py`: `fullmatch` | `tests/test_input_validation.py` (14): يقود تطبيق ASGI **ببايتات خام** لأن مكتبات HTTP تعيد ترميز الترويسة وتخفي الخلل؛ 8 تفشل دون الإصلاح |

**توافق:** لم يُعدَّل 0001 ولا 0002 (لا ترحيل مطبَّق يُغيَّر). اختبارات النمط (`[:2]`، «`pg_catalog` أولًا و`pg_temp` أخيرًا») تمر دون تعديل. النتائج: pytest **183** (151 + 18 + 14)، e2e **22/22** مع تطبيق 0001–0003.

> **تصحيح:** ورد سابقًا في هذه الوثيقة وفي تعليق المراجعة أن ادعاء الرقم اليونيكودي «لم يتكرر». كان ذلك خطأً في منهج اختباري (عميل الاختبار أعاد ترميز الترويسة)، والادعاء صحيح وقد أُثبت وأُصلح في الصف 18.

**لم يُعالج عمدًا (متابعة موثّقة):** إلزام `sslmode` في الإنتاج (يكسر e2e على قاعدة محلية بلا TLS؛ يُضبط في DSN المعاينة)، قفل `pg_advisory_lock` خلف Neon pooler (يُشغَّل الترحيل على النقطة المباشرة؛ يُتحقق في G6)، تحديد معدل `/api/health` (B2)، `pg_has_role('USAGE')` مقابل `MEMBER`، واختبار الدوال بمالك غير superuser. قائمة كاملة في `docs/verification/PR26-VERIFICATION-REPORT.md` (PR مستقل).
