# Railway — المرحلة 2: خدمة FastAPI (`safwan-api`) والربط الآمن

**الحالة:** مُجهَّزة كتغييرات معلّقة على Railway — **لم تُنشر**. آخر تحديث: 2026-11-01.
يكمل [RAILWAY-MIGRATION.md](RAILWAY-MIGRATION.md). مرجع المشروع: Railway Project ID `f66bca9a-b641-41d9-b755-70759d9ad808` (الاسم الحالي «Safwan Smart Assistant»)، بيئة `production`.

## البنية
```
المتصفح ──https──▶ @safwan/web (Next.js، نطاق عام :8080)
                      │  server-side فقط: GET /api/health  (BFF)
                      ▼  http://safwan-api.railway.internal:8000  (شبكة خاصة)
                  safwan-api (FastAPI، بلا نطاق عام)
```
- المتصفح لا يعرف عنوان الـAPI ولا يتصل بـ`.railway.internal`. العنوان في `BACKEND_URL` على خدمة الويب فقط (متغير خادم، بلا `NEXT_PUBLIC_`).
- الـAPI لا يضبط CORS عمدًا: لا استدعاء من المتصفح مباشرة، فلا يُضاف CORS.

## فحص FastAPI (مُتحقَّق منه)
| البند | النتيجة |
|---|---|
| نقطة الدخول | `services/api/app/main.py` → `app.main:app` |
| الاعتماديات | `fastapi>=0.115`, `uvicorn>=0.30`, `pydantic>=2`؛ `requires-python >=3.11`؛ تثبيت نظيف عبر `pip install .` ناجح (Python 3.13)؛ يُثبَّت 3.12 عبر `RAILPACK_PYTHON_VERSION` ليطابق CI |
| أمر التشغيل | `uvicorn app.main:app --host 0.0.0.0 --port $PORT` — جُرّب محليًا في وضع الإنتاج (بدون `APP_ENV`) |
| `/health` | 200 عام: `{"status":"ok","version":"0.2.0","features":{"assistant":false,"connected_integrations":0,"task_execution":false}}` |
| باقي المسارات (`/tools` `/capabilities` `/audit`…) | **503** في الإنتاج (المصادقة غير منفَّذة → fail-closed). لا مصادقة وهمية |
| `/docs` و`/openapi.json` | **200 عام في الإنتاج** — مقبول لأن الـAPI خاص؛ يجب تعطيلهما قبل أي كشف عام |
| CORS | غير مضبوط (مقصود) |
| وظائف غير مكتملة | الذكاء الاصطناعي، تنفيذ المهام، التكاملات، الحساب/الجلسات، قاعدة البيانات: **غير جاهزة**، والمسارات تقول ذلك صراحة |

> `PORT` يُضبط يدويًا (`8000`) لأن Railway لا يحقنه لخدمة بلا نطاق عام، وبدونه يفشل `--port $PORT`.
> البيئة أُنشئت بعد 2025-10-16 فهي ثنائية IPv4/IPv6، لذا `0.0.0.0` يكفي. إن فشل الاتصال الخاص عند أول نشر فالبديل `--host ::`.

## ما أضافه هذا الـPR
- `apps/web/server/health.ts` + `apps/web/app/api/health/route.ts`: مسار BFF يفحص `<BACKEND_URL>/health` من الخادم فقط. مسار ثابت، مهلة 3ث، لا يتبع التحويلات، سقف 64KB، تحقق من شكل الرد، ولا يُرجع عناوين أو أكواد أو نصوص أخطاء. بلا `BACKEND_URL` لا يُرسَل أي طلب.
- `lib/assistant.ts` صار يقرأ `/api/health` بدل `/backend/health` (الذي لا مسار له على Railway).
- `tests/health.test.ts`: 16 اختبارًا (الإعداد، التحويلات، 401/403/429/5xx، المهلة، الأجسام الفاسدة/الكبيرة، عدم تسريب العنوان).

**تنبيه تبعية:** `respond()` ما زال يستدعي `/api/assistant/respond` ولا يوجد له مسار BFF — مقصود، فهو يرفض قبلها لأن المساعد غير مفعّل. يُبنى مع المصادقة والمزوّد.

## إعداد Railway المعلّق (19 تغييرًا — لم يُطبَّق)
| الخدمة | الإعداد |
|---|---|
| `safwan-api` (جديدة) | المصدر `main`، Root `/services/api`، RAILPACK، Start كما أعلاه، Healthcheck `/health` (60ث)، ON_FAILURE×5، Watch `/services/api/**`، **بلا نطاق عام** |
| `safwan-api` متغيرات | `APP_ENV=production`, `ENABLE_DEV_AUTH=false`, `ASSISTANT_PROVIDER=none`, `PORT=8000`, `RAILPACK_PYTHON_VERSION=3.12` — لا أسرار ولا مفاتيح |
| `@safwan/web` | إضافة `BACKEND_URL=http://safwan-api.railway.internal:8000` فقط |

## نتائج الاختبار (محلي)
| الفحص | النتيجة |
|---|---|
| web: typecheck / lint / vitest / `next build` | نظيف / نظيف / 64 ناجح / ناجح (`ƒ /api/health` ديناميكي) |
| API: pytest | 47 ناجح |
| تكامل حي (uvicorn إنتاج + `next start`) | API يعمل → 200 `backend:"ok"`؛ API متوقف → 503 `unreachable`؛ بلا `BACKEND_URL` → 503 `unconfigured`؛ HTML الصفحة الرئيسية لا يحوي أي عنوان داخلي |
| لم يُختبر | الشبكة الخاصة الفعلية على Railway (تُختبر عند أول نشر) |

## تأثير PR #26 على Railway
| المحور | الحكم |
|---|---|
| `BFF → API` الموقَّع (`server/backend.ts`, HMAC+nonce) | **متوافق**: مستقل عن المنصة ويقرأ `BACKEND_URL` + `SERVICE_AUTH_SECRET`. يحل محل `server/health.ts` هنا (نفس المسار `/api/health` ونفس شكل الرد، فيُحل أي تعارض بأخذ نسخة #26) |
| `vercel.json` (Service Binding يحقن `BACKEND_URL`) | **خاص بـVercel**؛ على Railway يُستبدل بـ`BACKEND_URL` الخاص. دمجه يغيّر سلوك Vercel الحالي، ولم يُختبر على Vercel Preview |
| PostgreSQL + RLS + ترحيلات | يتطلب قاعدة على Railway: مخزن nonce الافتراضي `postgres` (و`memory` مسموح خارج الإنتاج فقط) → **الإنتاج لن يقبل الطلبات الموقَّعة بدون `APP_DATABASE_URL`**. هذا يربط #26 بالمرحلة 3 |
| دور التشغيل | `APP_DATABASE_URL` بدور `NOSUPERUSER NOBYPASSRLS`؛ `DATABASE_URL` (دور المالك) مُتجاهَل عمدًا — يجب ألا يُنسخ إلى الـAPI |
| الجلسات/المصادقة | نواة جلسات مضافة؛ لم تُختبر على بيئة الاستضافة |
| الاعتماديات | يضيف `psycopg[binary]` و`uv.lock` و`.python-version`؛ Railpack يدعم uv |
| قاعدة `main` | #26 مبني على `032b3bc` وقديم؛ يحتاج تحديثًا. وسيطلق دمجه إعادة نشر للخدمتين |
| الاستنتاج | **لا يُدمج الآن.** شروطه: Postgres على Railway + ترحيلات بدور المالك + دور تشغيل مقيَّد + اختبار الشبكة الخاصة + `SERVICE_AUTH_SECRET` (Sealed، 32 بايت+، نفسه في الخدمتين) + مراجعة تأثيره على `vercel.json` |

> فُحصت ملفات #26 المذكورة أعلاه فقط (`vercel.json`, `server/{backend,health}.ts`, `app/api/health/route.ts`, `lib/assistant.ts`, `config.py`, `pyproject.toml`)، لا كامل الـ60 ملفًا.

## أثر هذا الـPR على Vercel
شارة «الخادم» في الإعدادات/اللوحة ستظهر **«غير متصل»** على Vercel بعد الدمج، لأن Vercel لا يملك `BACKEND_URL` (كان يعتمد على إعادة كتابة `/backend/health`). الأثر شكلي فقط: التطبيق محلي أولًا ولا وظيفة تعتمد على الحالة. لا تعديل على `vercel.json` أو مشروع Vercel.

## التصميم المستقبلي (محفوظ)
`@safwan/web` · `safwan-api` · `safwan-worker` · PostgreSQL · Browserbase (مزوّد خارجي).
- **Worker لا يُشغَّل الآن.** يُنشأ لاحقًا كخدمة مستقلة بلا نطاق عام، تتصل بـAPI وPostgres عبر الشبكة الخاصة.
- مفاتيح Browserbase (`BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`) تُوضع على Worker فقط، Sealed، ولا تصل خدمة الويب أبدًا.
- لا مفاتيح إنتاج في أي اختبار غير معزول.

## أول نشر للـAPI (بعد موافقتك)
1. راجع هذا الـPR ثم ادمجه (أو أخبرني). الدمج يعيد نشر `@safwan/web` تلقائيًا (Watch Patterns).
2. في Railway: Staged Changes → Deploy. يُنشئ `safwan-api` ويعيد نشر الويب بـ`BACKEND_URL`.
3. التحقق: سجل `safwan-api` يُظهر `Uvicorn running on 0.0.0.0:8000` وHealthcheck ناجح؛ ثم `GET https://safwanai.up.railway.app/api/health` ⇒ 200 و`"backend":"ok"`.
4. فشل ⇒ `redeploy` للويب أو حذف خدمة `safwan-api` المعلّقة؛ الواجهة تعمل بدون الـAPI.
