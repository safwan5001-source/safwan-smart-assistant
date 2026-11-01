# Railway — المرحلة 3: PostgreSQL والمصادقة (تقرير جاهزية + Runbook)

**الحالة:** جاهز تقنيًا للإطلاق بعد موافقتك. **لم يُنشأ شيء على Railway** (لا PostgreSQL، لا خدمات، لا متغيرات، لا نشر)، ولم يُدمج PR #26، ولم يُمَسّ Vercel أو مشروع أَوْج.
يكمل [RAILWAY-API-PHASE2.md](RAILWAY-API-PHASE2.md). Railway Project ID: `f66bca9a-b641-41d9-b755-70759d9ad808`، بيئة `production`.

## 1. الخلاصة
| السؤال | الجواب |
|---|---|
| هل PR #26 متوافق مع Railway؟ | **نعم، كود وتصميمًا.** الموقِّع والـRLS والجلسات لا تعتمد على منصة. الجزء الوحيد الخاص بـVercel هو `vercel.json` (Service Binding) وقد أُعيد إلى نسخة `main`. |
| هل هو جاهز للدمج؟ | **تقنيًا نعم، وإجرائيًا لا**: يحتاج PostgreSQL وأسرارًا وترتيب إطلاق (§7). **لم يُدمج.** |
| هل المصادقة مكتملة؟ | **لا — وهذا مقصود.** الموجود: توقيع خدمة↔خدمة (BFF→API) ونواة جلسات في قاعدة البيانات. **لا يوجد مسار تسجيل دخول ولا إنشاء حساب** (Passkeys في B2). لا مستخدم نهائي يستطيع الدخول بعد هذا الإطلاق. |
| أكبر خطر اكتُشف | قاعدة Railway هي **PostgreSQL 18** بينما كان CI على **16** فقط. أُصلح: CI على 16 و18 معًا، وكل الاختبارات تمر عليهما. |

## 2. ما راجعته في PR #26
60 ملفًا (+3509 −103، 12 commit): ترحيلات SQL (`0001–0003`) ومشغّل ترحيل بـchecksum، RLS على 4 جداول، سجل تدقيق للإلحاق فقط، نواة جلسات (7/30 يومًا)، توقيع HMAC مع نافذة ±60ث ونونس أحادي الاستعمال في PostgreSQL، عميل BFF خادمي، واختبارات (136 pytest، 91 vitest، e2e). فرعه كان قديمًا (`032b3bc`) فدُمج فيه `main` الحالي (merge commit، بلا إعادة كتابة تاريخ).

| المحور | الحكم | ملاحظة |
|---|---|---|
| توقيع BFF→API | متوافق | يقرأ `BACKEND_URL` و`SERVICE_AUTH_SECRET`؛ على Railway `BACKEND_URL=http://safwan-api.railway.internal:8000` (مضبوط فعلًا على الويب). |
| `vercel.json` (Service Binding) | **أُزيل من نطاق الـPR** | أُعيد حرفيًا إلى نسخة `main` فلا يتغير سلوك Vercel بالدمج. استُبدل `test_vercel_config.py` بـ`test_deploy_topology.py` (يثبت أن Vercel لا يوجّه شيئًا من `/internal` علنًا وأن الويب بلا بروكسي إلى الـAPI). |
| PostgreSQL + RLS | متوافق بعد اختبار 16 و18 | §5. |
| الشبكة الخاصة | متوافق | API بلا نطاق عام (تحققت: لا نطاقات ولا TCP proxy)، والويب يصله عبر `.railway.internal`. |
| الجلسات | سليمة، بلا واجهة | الخلق/الحل/الإبطال تعمل وتُختبر؛ لا endpoint يستدعيها بعد. |
| `/health` للـAPI | يبقى بلا قاعدة بيانات | Healthcheck في Railway لا يعتمد على PostgreSQL، فانقطاع القاعدة لا يُسقط الـAPI في حلقة إعادة تشغيل. |

## 3. المشاكل المكتشفة وإصلاحها
| # | المشكلة | الأثر | الإصلاح والإثبات |
|---|---|---|---|
| 1 | تعارض الدمج مع `main` في 6 ملفات + `uv.lock` (مسبار #32 غير الموقَّع مقابل الموقَّع في #26) | بناء مكسور | نسخة #26 الموقَّعة تحل محل المسبار؛ `uv.lock` أُعيد توليده (27 حزمة). |
| 2 | `backend.ts` في #26 فيه **العيبان نفسهما** اللذان أصلحتُهما في #32 بعد مراجعة Codex: `res.text()` يخزّن الجسم كله، و`text.length` يعدّ UTF-16 لا بايتات، وأجسام الردود غير 200 تُترك دون إلغاء | استنزاف ذاكرة/اتصالات من ردّ خبيث أو عالق | نُقل الإصلاح كاملًا إلى `backend.ts` (قراءة تدفقية بالبايت، إلغاء الجسم، `abort` في `finally`) + 9 اختبارات. كانت ستضيع بدمج #26 كما هو. |
| 3 | `/api/health` **عام** وكل طلب = توقيع + اتصال PostgreSQL جديد + سطر nonce | أي أحد يستطيع تضخيم الحمل على القاعدة (PostgreSQL يحدّ الاتصالات؛ الافتراضي العام 100 ولم أتحقق من قيمة Railway) | كاش 5ث في خادم Next مع مشاركة المسبار الجاري (`HEALTH_CACHE_MS`، 5 اختبارات). e2e: **40 طلبًا متزامنًا = مسبار واحد**؛ ومع الكاش مُعطَّلًا كل طلب يستهلك nonce جديدًا (10/10). |
| 4 | ترويسات `x-svc-*` المكرَّرة تُقبل إذا كانت الأولى صحيحة | غموض (first-wins هنا وlast-wins في بعض الوسطاء) | رفض أي تكرار بـ401 الموحّد، دون استهلاك النونس. 8 اختبارات. |
| 5 | `APP_ENV=development` بالخطأ على Railway يفتح الـAPI (المصادقة `open_dev`) | كشف كل المسارات المحمية | أي متغير `RAILWAY_*` يفرض `production` (كما يفعل `VERCEL_ENV`). 5 اختبارات. |
| 6 | حارس `uv.lock` (من #33) لا يفهم `psycopg[binary]` | إيجابية كاذبة تمنع تحديث الاعتماديات | أُصلح ليفهم extras + اختباران. (عيب في عملي السابق.) |
| 7 | قاعدة Railway **18** وCI **16** | فروق إصدار لا تُرى قبل الإنتاج | CI: مصفوفة `postgres 16/18`، وe2e على 18. ⚠️ اسم الفحص صار `api (postgres 16)`/`api (postgres 18)`؛ إن كان `api` مطلوبًا في حماية الفرع فحدّثه. |
| 8 | الترحيل عبر Pre-deploy command يضع بيانات **المالك** في بيئة تشغيل الـAPI | اختراق الـAPI يكشف مفتاح تغيير المخطط | خدمة مهام مستقلة `safwan-db-job` لا يصلها الـAPI (§6). |
| 9 | مستخدم Railway الافتراضي `postgres` **superuser** | يملك الجداول ودوال `SECURITY DEFINER` فتعمل بصلاحية superuser، ويتجاوز RLS | وحدة `app.db.bootstrap` (جديدة): مالك غير مميَّز + قاعدة مغلقة على PUBLIC + دخول تشغيل مقيَّد بسقف 40 اتصالًا. 23 اختبارًا + تجربة على عنقود فارغ. |
| 10 | FORCE RLS غير مفعّل على `accounts`/`sessions` | (بالتصميم) | دالة البحث `SECURITY DEFINER` تعمل بصفة المالك وسيفلترها FORCE إلى لا شيء. الحماية: دور التشغيل ليس مالكًا ولا BYPASSRLS (يُفرض عند الاتصال)، ولا مسار مباشر. **FORCE مفعّل على `sync_records` و`audit_log`.** الآن مثبّت باختبار. |

## 4. مخاطر متبقية (صريحة)
1. **لا مصادقة مستخدم بعد.** الـBFF يدّعي الحساب في ترويسة موقَّعة؛ **اختراق الويب = انتحال أي حساب** (يملك السر). لذلك السر Sealed ويُدوَّر.
2. **ترميز المسار:** الـAPI يوقّع على المسار *بعد فك الترميز* (`/internal/v1/%70ing` ≡ `/ping`). مسارات الـBFF ثابتة بأحرف بسيطة فلا يُستغل، لكنه لو اختلف ترميز العميل عن الخادم لفشل مغلقًا. لم أغيّر ما يمسّ العقد المثبَّت.
3. **لا تحديد معدّل** على `/api/health` غير الكاش (B2).
4. **اتصال جديد لكل نونس** (لا pool)؛ الكاش يبقيه ضئيلًا. يلزم pool قبل أي حمل حقيقي.
5. **TLS للقاعدة:** قالب Railway يفعّل SSL بشهادة ذاتية؛ الاتصال داخل شبكة خاصة مشفّرة (WireGuard). أوصي بـ`?sslmode=require` في الـDSN — **لم أتحقق منه** (لا قاعدة Railway لأجرّب عليها)؛ أول فحص صحة سيكشف الخطأ.
6. **السرّ في سجلات الخادم:** `CREATE/ALTER ROLE … PASSWORD` قد يظهر في سجل PostgreSQL إن فُعِّل `log_statement=ddl`. الافتراضي `none`؛ تحقق منه.
7. **`/docs` و`/openapi.json`** في الـAPI عامَّان داخليًا (الـAPI خاص). عطّلهما قبل أي كشف.

## 5. نتائج الاختبارات
| الفحص | النتيجة |
|---|---|
| pytest على **PostgreSQL 16.15** (حقيقي، `REQUIRE_POSTGRES=1`، لا تخطّي) | **237 ناجح** |
| pytest على **PostgreSQL 18.6** (نفس إصدار قالب Railway) | **237 ناجح** |
| vitest | **108 ناجح** (typecheck وlint و`next build` نظيفة) |
| e2e حقيقي: Next.js → API (إنتاج، دور مقيَّد) → PostgreSQL، على 16 و18 | **كل الفحوص ناجحة** (توقيع، إعادة 401، سرّ خاطئ، غير مضبوط، الـAPI متوقف، حدّ الحمل) |
| تمرين نسخ احتياطي/استعادة بين عنقودين (`scripts/backup-restore-rehearsal.sh`) | **ناجح مرتين** |
| بروفة runbook الإعداد على عنقود 18 فارغ بالأوامر الفعلية | **ناجحة** (§6) |
| اختبارات الطفرات (كسر الحماية عمدًا فيجب أن يفشل الاختبار) | **9/9 التُقطت**: عدم استعادة النطاق المتداخل، تكرار الترويسات، منح `DELETE`، سياسة جلسات مفتوحة، ترك القاعدة مفتوحة لـPUBLIC، مالك superuser، دور تشغيل superuser، بلا سقف اتصالات، فقدان trigger الإبطال بعد الاستعادة |

**اختبارات الأمان الخصومية** (`tests/test_phase3_adversarial.py`، على دور تشغيل حقيقي لا superuser):
- **تسرب نطاق الحساب:** fuzz عشوائي لتداخل حتى 4 مستويات مع استثناءات عشوائية (>500 تحقق) + 9 اتصالات متوازية تتناوب حسابات: لا حساب رأى صفًّا لغيره، ولا قراءة بلا نطاق تُرجع شيئًا.
- **الإبطال:** حساب لا يقرأ/يبطل/يُحيي جلسات غيره؛ الإبطال دائم حتى للتطبيق؛ تعطيل الحساب وانتهاء الصلاحية يسريان فورًا؛ السرّ غير قابل للاسترجاع من القاعدة.
- **الصلاحيات:** مصفوفة صلاحيات دور التشغيل مثبّتة حرفيًا (جدول جديد لا يُضاف دون مراجعة).
- **الترويسات:** التكرار، والمسار/الاستعلام/الطريقة/الجسم/الحساب مغطاة بالتوقيع.

## 6. إعداد PostgreSQL على Railway (Runbook — لم يُنفَّذ)
### البنية المقترحة
```
@safwan/web ──signed──▶ safwan-api ──runtime login──▶ Postgres (خاص، بلا نطاق/TCP proxy)
                                                          ▲
safwan-db-job ───owner login (migrate + bootstrap)────────┘   (لا يصله الـAPI ولا الويب)
```
| الدور | يملكه | يستخدمه |
|---|---|---|
| `postgres` (superuser، يُنشئه القالب) | Railway | **مرة واحدة** فقط في `bootstrap owner`، ثم يُحذف متغيره من الخدمة |
| `safwan_owner` (NOSUPERUSER، CREATEROLE) | يملك القاعدة `safwan` والجداول | `safwan-db-job` فقط |
| `safwan_runtime` (عضو في `safwan_app`، بلا BYPASSRLS، سقف 40 اتصالًا) | لا يملك شيئًا | `safwan-api` فقط |

### الأسرار (تُضبط من لوحة Railway، **Sealed**؛ لا تمرّ عبر هذه المحادثة)
| المتغير | الخدمة | ملاحظة |
|---|---|---|
| `SERVICE_AUTH_SECRET` | **مشترك** `${{shared.SERVICE_AUTH_SECRET}}` في الويب والـAPI | `openssl rand -base64 48` (≥32 بايت). التدوير: `SERVICE_AUTH_SECRET_PREVIOUS` أثناء النافذة. |
| `RUNTIME_PASSWORD` | مشترك | يستخدمه `safwan-db-job` (يُنشئ الدور) والـAPI (يتصل به) |
| `OWNER_PASSWORD` | `safwan-db-job` فقط | |
| `BOOTSTRAP_DATABASE_URL` | `safwan-db-job` **مؤقتًا** | `postgresql://postgres:${{Postgres.POSTGRES_PASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/railway` — يُحذف بعد المرحلة 1 |
| `MIGRATION_DATABASE_URL` | `safwan-db-job` فقط | `postgresql://safwan_owner:${{OWNER_PASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/safwan?sslmode=require` |
| `APP_DATABASE_URL` | `safwan-api` فقط | `postgresql://safwan_runtime:${{shared.RUNTIME_PASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/safwan?sslmode=require` |

**ممنوع** على الـAPI: `DATABASE_URL` أو أي مرجع إلى `${{Postgres.DATABASE_URL}}` (دور superuser). الكود يتجاهله، والحارس يرفض الاتصال به في الإنتاج. المتغيرات المحمية Sealed لا تُمرَّر إلى `railway run` — فلا تُشغَّل الترحيلات بهذه الطريقة.

### الخطوات (وكلها جُرّبت بالأوامر نفسها على عنقود 18 فارغ)
1. **PostgreSQL:** قالب `postgres` (الصورة `ghcr.io/railwayapp-templates/postgres-ssl:18`، volume على `/var/lib/postgresql/data`). **لا TCP proxy ولا نطاق.** فعّل Volume Backups المجدولة (§8).
2. **`safwan-db-job`:** خدمة جديدة من المستودع، Root `/services/api`، بلا نطاق، Restart Policy `NEVER`، Watch `/services/api/migrations/**`.
   - Start Command مؤقتًا: `python -m app.db.bootstrap owner` ← ينشئ `safwan_owner` وقاعدة `safwan` ويغلقها على PUBLIC. المتوقع في السجل: `created owner role safwan_owner; created database safwan; database safwan closed to PUBLIC`.
   - احذف `BOOTSTRAP_DATABASE_URL`. غيّر Start Command إلى: `python -m app.db.migrate && python -m app.db.bootstrap runtime` ← `applied: 0001, 0002, 0003` ثم `created runtime login safwan_runtime; runtime may connect`. إعادة التشغيل آمنة (`nothing (up to date)` ويدوّر كلمة المرور).
3. **الـAPI:** أضف `APP_DATABASE_URL` و`SERVICE_AUTH_SECRET`. **الويب:** أضف `SERVICE_AUTH_SECRET`. (`BACKEND_URL` موجود.)
4. **ثم** ادمج #26 (الشيفرة الموقَّعة تبدأ العمل عند النشر).

### ترتيب الترحيلات وسياسة الأمان
- الترحيلات متسلسلة (`0001…`)، كل ملف في معاملة واحدة، مع checksum وقفل استشاري؛ **تعديل ترحيل مُطبَّق = رفض**، وقاعدة أحدث من البناء = رفض.
- لأن الـAPI و`safwan-db-job` يُبنيان من الـcommit نفسه قد يبدآن معًا: **كل ترحيل متوافق مع الكود السابق (إضافة فقط)، وPR الترحيل يسبق PR الكود الذي يستخدمه.**

## 7. خطة النشر التدريجية
| المرحلة | الإجراء | التحقق | الرجوع |
|---|---|---|---|
| 0 | موافقتك + إنشاء الأسرار Sealed (لا تمرّ بي) | — | — |
| 1 | PostgreSQL (الخطوة 1) | الخدمة Online؛ `list-domains` و`list-tcp-proxies` فارغتان؛ Backups مفعّلة | احذف الخدمة (لا بيانات بعد) |
| 2 | `safwan-db-job` (الخطوة 2) | سجل المرحلتين كما في §6؛ لا أخطاء | أعد التشغيل (آمن) أو احذف الخدمة والقاعدة |
| 3 | متغيرات الـAPI والويب (معلّقة، دون نشر) | مراجعة Staged Changes: تخص الخدمتين فقط | ألغِ التغييرات المعلّقة |
| 4 | دمج #26 → نشر تلقائي للخدمتين | `https://safwanai.up.railway.app/api/health` ⇒ **200 و`backend:"ok"`**؛ سجل الـAPI بلا `service auth denied` غير متوقعة؛ إعادة نفس الطلب ⇒ 401 | **Railway Rollback** لنشر الويب/الـAPI السابق (`canRollback`) أو revert للـPR؛ المتغيرات الإضافية لا تضر |
| 5 | تمرين استعادة على Railway (§8) | قبل أي بيانات حقيقية | — |
| 6 | تنبيهات (webhook للفشل) ومراقبة اتصالات القاعدة | — | — |

حالات فشل متوقعة وتشخيصها من `/api/health`: `unconfigured` ⇒ سرّ/عنوان ناقص في الويب؛ `rejected` ⇒ سرّان مختلفان؛ `unavailable` ⇒ الـAPI يرفض القاعدة (دور خاطئ/غير مهاجَر/كلمة مرور)؛ `unreachable` ⇒ الشبكة الخاصة أو الـAPI متوقف.

## 8. النسخ الاحتياطي والاستعادة
| الطبقة | الأداة | الحالة |
|---|---|---|
| لقطات مجدولة للـvolume | Backups في Railway (تزايدية؛ تُفوتر بمقدار البيانات الفريدة) | **تُفعَّل في المرحلة 1** (بعد موافقتك على التكلفة) |
| استعادة لحظية (PITR) | pgBackRest إلى bucket (أسبوعيًا full، يوميًا differential، آخر 4 full ≈ 4 أسابيع) | **اختيارية** وتتطلب bucket مدفوعًا — قرارك |
| نسخة منطقية خارج المنصة | `pg_dump --format=custom` | شهريًا على الأقل وقبل كل ترحيل؛ يلزم TCP proxy مؤقت أو خدمة مجدولة (قرار لاحق) |

**الاستعادة من لقطة:** تبويب Backups ← Restore ← يُجهَّز volume جديد باسم تاريخ اللقطة ويبقى القديم محفوظًا ← راجع التغييرات المعلّقة ← Deploy. بعدها: `/api/health` ثم تحقق الأدوار.
**الاستعادة المنطقية (جُرّبت فعلًا بين عنقودين):** الترتيب مهم — **أنشئ الأدوار أولًا** (`CREATE ROLE safwan_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`) وإلا يُرفض `pg_restore` (جُرّب)، ثم `pg_restore --no-owner`، ثم `python -m app.db.migrate` (لا يفعل شيئًا) و`bootstrap runtime`. أثبت التمرين بعد الاستعادة: الأعداد سليمة، RLS/FORCE كما هي، مصفوفة الصلاحيات نفسها، جلسة حيّة تعمل، **جلسة مُبطَلة تبقى مُبطَلة**، trigger الإبطال سليم، والدور المميَّز مرفوض.
**غير مُجرَّب بعد:** استعادة اللقطات على Railway نفسها (لا قاعدة هناك). هذا شرط قبل البيانات الحقيقية (المرحلة 5).

## 9. ما يلزم منك قبل الإطلاق
1. موافقة على **موارد مدفوعة**: خدمة PostgreSQL + volume + (اختياريًا) Backups/PITR/bucket، وخدمة `safwan-db-job`. لم أنشئ شيئًا.
2. إنشاء الأسرار Sealed بنفسك (`SERVICE_AUTH_SECRET`، `RUNTIME_PASSWORD`، `OWNER_PASSWORD`).
3. تحديث حماية الفرع إن كان فحص `api` مطلوبًا (صار `api (postgres 16/18)`).
4. قرار PITR، وقرار سياسة النسخ المنطقي.
5. موافقة صريحة على دمج #26 بعد المرحلة 3.

## 10. مراجع الشيفرة والأدوات
`services/api/app/db/{bootstrap,migrate,connection,scope}.py` · `migrations/0001–0003` · `app/service_auth.py` · `app/auth/sessions.py` · `apps/web/server/{backend,health,service-signature}.ts` · `scripts/{e2e-bff,backup-restore-rehearsal}.sh` · `tests/{test_phase3_adversarial,test_bootstrap,test_deploy_topology,test_runtime_deps}.py`.
