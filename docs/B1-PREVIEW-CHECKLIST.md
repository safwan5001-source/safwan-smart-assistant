# B1 — قائمة إثبات الاتصال والعزل على Vercel Preview

**الحالة: لم يُنفَّذ.** الكود والإعداد جاهزان، لكن لا أملك وصولاً إلى مشروع Vercel (استدعاءات الأداة رجعت 403) ولا إلى المعاينة (خلف مصادقة). **لا تدمج PR B1 قبل اجتياز هذه القائمة** — لأن دمجه يغيّر `vercel.json` للإنتاج.

## أ) إجراءات تقوم بها أنت (لا أسرار في المحادثة أو المستودع)
1. **Neon:** أنشئ قاعدة/فرع للمعاينة (ليس الإنتاج).
2. بدور **المالك**: `MIGRATION_DATABASE_URL=<owner dsn> pnpm db:migrate` (يُنشئ `safwan_app` والجداول). أو شغّل ملفات `services/api/migrations/*.sql` بالترتيب.
3. أنشئ دور الدخول **بنفس دور المالك الذي شغّل الترحيل** (هو من أنشأ `safwan_app` فيملك ADMIN عليه؛ إن أُنشئ `safwan_app` من لوحة أخرى فقد تحتاج `GRANT safwan_app TO <owner> WITH ADMIN OPTION`). كلمة مرور قوية تولّدها أنت:
   ```sql
   CREATE ROLE safwan_runtime LOGIN PASSWORD '<generated>' IN ROLE safwan_app NOSUPERUSER NOBYPASSRLS;
   ```
4. في Vercel → Environment Variables (نطاق **Preview** فقط، علّم الأسرار **Sensitive**):
   | المتغير | القيمة | الخدمة |
   |---|---|---|
   | `SERVICE_AUTH_SECRET` | `openssl rand -base64 48` | web + backend (نفس القيمة) |
   | `APP_DATABASE_URL` | DSN دور `safwan_runtime` (**ليس** المالك) | backend |
   | `APP_ENV` | `production` (لتجربة وضع الفشل المغلق الحقيقي) | backend |
   | `BACKEND_URL` | **لا تضبطه** — يحقنه الـ binding | web |
   > تحذير: تكامل Neon يضيف `DATABASE_URL` بدور المالك. التطبيق **يتجاهله** عمداً؛ لا تنسخه إلى `APP_DATABASE_URL`.
5. تحقق أن **Root Directory** في إعدادات المشروع لا يمنع قراءة `vercel.json` الجذري (فرضية Phase 5: قد تحتاج تفريغ الحقل `apps/web`). وأن **Services (Beta)** مفعّلة.
6. للوصول إلى المعاينة المحمية: استخدم Deployment Protection Bypass من لوحة Vercel أو افتح الرابط وأنت مسجّل الدخول.

## ب) فحوصات النجاح (على رابط المعاينة)
| # | الفحص | المتوقع |
|---|---|---|
| 1 | `GET /api/health` | 200 و`{"status":"ok","web":"ok","backend":"ok","features":{"assistant":false,…}}` |
| 2 | `GET /backend/health` | **404** (لا مسار عام للخلفية) |
| 3 | `GET /api/health` عدة مرات متتالية | كلها 200 (nonce جديد لكل طلب؛ لا رفض تكرار كاذب) |
| 4 | `POST /api/health` | 405 |
| 5 | الرأس `Cache-Control` | `no-store` |
| 6 | الواجهة (الإعدادات ← حالة النظام) | «الخادم: متصل»، «المساعد الذكي: غير مفعّل» |
| 7 | أي مسار آخر خلف الواجهة | لا يكشف FastAPI (`/tools`, `/tasks`, `/openapi.json`, `/docs` → صفحة 404 لـ Next) |
| 8 | سجلات Vercel للخلفية | لا تظهر أسرار أو DSN أو توقيعات |

## ج) فحوصات الفشل المغلق (اختيارية لكن موصى بها)
| الفحص | المتوقع |
|---|---|
| غيّر `SERVICE_AUTH_SECRET` في خدمة web فقط ثم أعد النشر | `/api/health` → 503 و`backend:"rejected"` |
| احذف `APP_DATABASE_URL` من الخلفية | 503 و`backend:"unavailable"` |
| اجعل `APP_DATABASE_URL` يشير إلى دور المالك (حتى لو لم يكن superuser) | 503 (`service_auth_unavailable`، رفض دور مميّز) |

## د) إن ظهر `backend:"rejected"` رغم تطابق السر
الاحتمال الأرجح أن المنصة تغيّر المسار الذي تراه الخلفية (بادئة) فيختلف الهدف الموقَّع. سجّل ما تراه (دون أسرار) وأبلغني: الحل إعداد بادئة مسار موثَّقة في جانب الـ API (تغيير صغير ومختبَر)، وليس إضعاف التحقق.

## هـ) الرجوع
أعد `vercel.json` إلى نسخة `main` السابقة (يُكشف `/backend/health` فقط). لا بيانات مستخدم تتأثر (B1 لا يلمس البيانات المحلية).

## و) تسجيل النتيجة
اكتب النتائج (✅/❌ مع لقطة أو نص مقتطع بلا أسرار) في تعليق على الـ PR. لا يُعدّ «الاتصال مثبتاً» إلا بعد الجدول (ب) كاملاً.
