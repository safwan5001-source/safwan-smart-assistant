# نقل «مساعد صفوان الذكي» من Vercel إلى Railway

**آخر تحقق:** 2026-11-01 17:58 UTC (قراءة مباشرة من Railway وGitHub والنطاق العام). لا أسرار ولا قيم متغيرات في هذه الوثيقة، أسماء فقط.

## القرارات المعتمدة
- Railway منصة الاستضافة الأساسية؛ المشروع **Safwan Smart Assistant** (`f66bca9a-b641-41d9-b755-70759d9ad808`)، البيئة `production` (`ecd10ac2-…`)، بلا Staging. (كان اسمه `natural-miracle`.)
- يبقى Vercel احتياطيًا مؤقتًا دون أي تعديل إلى أن يثبت نجاح النقل.
- مشروع «أَوْج AWJ» مستقل ولا يُعدَّل. اطُّلع على مقاييس استهلاكه للقراءة فقط لتقدير التكلفة المشتركة.
- لا Spending Hard Limit (يوقف كل خدمات مساحة العمل ومنها أَوْج). الخطة: Hobby.

## الحالة الحالية (مُتحقَّق منها)
| الخدمة | الحالة | التفاصيل |
|---|---|---|
| `@safwan/web` | ✅ SUCCESS | https://safwanai.up.railway.app (المنفذ 8080)؛ Next.js؛ Healthcheck `/`؛ آخر نشر من `c8e87d1` (#32)؛ المنطقة `ams` |
| `safwan-api` | ✅ SUCCESS | FastAPI، **بلا نطاق عام**، شبكة خاصة؛ Root `/services/api`؛ يُثبَّت من `uv.lock` (#33)؛ `uvicorn app.main:app --host 0.0.0.0 --port $PORT`؛ Healthcheck `/health` (لا يعتمد على قاعدة البيانات) |
| `Postgres` | ✅ SUCCESS (فارغة) | `ghcr.io/railwayapp-templates/postgres-ssl:18` (PostgreSQL 18.6)؛ **بلا نطاق عام وبلا TCP proxy**؛ volume `postgres-volume` على `/var/lib/postgresql/data`؛ `ams`. لم تُنشأ فيها بعد أدوار ولا جداول |
| `safwan-db-job` | ⏸ ساكنة عمدًا | **بلا مصدر وبلا أي نشر**، فلا تعمل قبل إدخال الأسرار. Root `/services/api`، Restart Policy `NEVER`، أمر المرحلة 1 `python -m app.db.bootstrap owner`، بلا نطاق |

**الاتصال بين Web وAPI (تحقق الآن):** `https://safwanai.up.railway.app/api/health` ⇒ **HTTP 200** و`"backend":"ok"` (الإصدار 0.2.0)؛ `/` و`/chat` ⇒ 200؛ `/backend/health` ⇒ 404 (لا بروكسي عام إلى الـAPI). الويب يصل الـAPI من خادم Next.js فقط عبر `BACKEND_URL` على الشبكة الخاصة.

### أسماء المتغيرات الحالية (بلا قيم)
| الخدمة | المتغيرات |
|---|---|
| `@safwan/web` | `APP_ENV` · `ASSISTANT_PROVIDER` · `BACKEND_URL` · `ENABLE_DEV_AUTH` · `NEXT_TELEMETRY_DISABLED` |
| `safwan-api` | `APP_ENV` · `ASSISTANT_PROVIDER` · `ENABLE_DEV_AUTH` · `PORT` · `RAILPACK_PYTHON_VERSION` |
| `safwan-db-job` | `APP_ENV` · `ASSISTANT_PROVIDER` · `ENABLE_DEV_AUTH` · `RAILPACK_PYTHON_VERSION` · `SMOKE_REQUIRE_SSL` · وثلاثة روابط مراجع: `MIGRATION_DATABASE_URL` · `APP_DATABASE_URL` · `BOOTSTRAP_DATABASE_URL` (تنتظر `OWNER_PASSWORD` و`RUNTIME_PASSWORD`) |
| `Postgres` | متغيرات القالب الرسمي (`POSTGRES_*` و`PG*` و`DATABASE_URL`)؛ **لا يُستعمل `DATABASE_URL` في أي تطبيق** |

لا يملك الويب أي بيانات اعتماد لـPostgreSQL. والـAPI لن يملك إلا دور التشغيل المقيَّد.

## مراحل النقل
| المرحلة | الحالة |
|---|---|
| 1 — الواجهة على Railway | ✅ منجزة |
| 2 — خدمة FastAPI الخاصة وربطها بالويب | ✅ منجزة (#32 و#33) |
| 3 — PostgreSQL والمصادقة | 🔄 قاعدة 18 تعمل وفارغة؛ بانتظار الأسرار ثم bootstrap والترحيلات و`smoke`؛ PR #26 جاهز تقنيًا ولم يُدمج |
| 4 — Worker (Browserbase) | ⏳ لم يبدأ، ولا تُنقل مفاتيح Browserbase إلى الويب أبدًا |
| 5 — القطع النهائي (نطاق/DNS) وإيقاف Vercel | ⏳ بموافقة صريحة |

## أحداث مهمة وتصحيحاتها
- متغير `NODE_ENV` اليدوي أُزيل قبل أول نشر للواجهة (كان قد يُفشل البناء بتخطي devDependencies).
- فشل أول نشر للـAPI بـ`uvicorn: command not found`: Railpack لا يثبّت اعتماديات `pyproject.toml` دون ملف قفل؛ أُصلح بـ`uv.lock` مع اختبار حارس (#33).
- حجم volume القاعدة ظهر **5000 MB** (افتراضي الخطة) رغم أن المطلوب أصغر. لا يمكن تصغيره. الاستعمال الحالي نحو 0.13 GB؛ التكلفة بين سنتات و0.75 دولار شهريًا حسب أساس الفوترة (غير موضّح في وثائق Railway). تُراجَع في صفحة Usage بعد 24 ساعة.
- أسقف الموارد (Postgres: 0.5 vCPU و0.5 GB؛ المهمة: 0.25 و0.25) تُطبَّق على الخدمة الحية بعد إنشائها ولم تُطبَّق بعد.

## Vercel
لم يُعدَّل `vercel.json` ولا مشروع Vercel في أي مرحلة. معاينات Vercel كانت حمراء على #30–#33 (سبب غير مؤكد؛ سجلاتها غير متاحة للأداة) وصارت Ready على فرع #26. شارة «الخادم» على Vercel تعرض «غير متصل» لأنها لا تملك `BACKEND_URL`، وهذا شكلي.

## PR #26 (لا يُدمج الآن)
جاهز تقنيًا: كل الفحوص خضراء (PostgreSQL 16 و18 وweb وe2e وCodex)، وحالة الدمج نظيفة. **لا يُدمج** قبل: إدخال الأسرار (Sealed) → bootstrap المالك → الترحيلات → bootstrap التشغيل → `smoke` أخضر على Railway → موافقتك الصريحة. `vercel.json` ليس جزءًا منه. التفاصيل الكاملة والـrunbook على فرع الـPR: [RAILWAY-PHASE3-DB-AUTH.md](https://github.com/safwan5001-source/safwan-smart-assistant/blob/feat/b0-b1-foundation/docs/deploy/RAILWAY-PHASE3-DB-AUTH.md) (تصل إلى `main` مع الدمج). مرحلة 2: [RAILWAY-API-PHASE2.md](RAILWAY-API-PHASE2.md).

## Browserbase والكمبيوتر السحابي (مستقبلًا)
الجلسات من Worker خاص على Railway بلا نطاق عام؛ مفاتيح `BROWSERBASE_API_KEY` و`BROWSERBASE_PROJECT_ID` Sealed على الـWorker فقط. الحزمة `poc/smoke1` تبقى معزولة داخل `poc/`. لم يُشغَّل Worker.

## الرجوع
حذف أي خدمة جديدة أو تعطيل نطاقها لا يؤثر على Vercel. لا نقل DNS قبل المرحلة 5. رجوع الويب/الـAPI: Railway Rollback (الصور محفوظة 72 ساعة على Hobby) أو revert للـPR. قاعدة البيانات الحالية فارغة، فحذفها لا يفقد بيانات.
