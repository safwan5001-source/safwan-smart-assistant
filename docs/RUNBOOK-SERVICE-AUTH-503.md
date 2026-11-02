# Runbook — `/api/health` = 503 و`no valid SERVICE_AUTH_SECRET`

## العَرَض
- `GET /api/health` يعطي 503 (`backend: unavailable`).
- سجل `safwan-api`: `service auth unavailable: no valid SERVICE_AUTH_SECRET (status=…)`، وبعده `GET /internal/v1/ping … 503`.
- `SERVICE_AUTH_SECRET` موجود (Sealed) في الخدمتين، ونشرهما `SUCCESS`.

## السبب الجذري (مثبت بالكود والاختبارات)
الرسالة تصدر من **شرط واحد** في `services/api/app/service_auth.py` (`require_service_call`): قيمة `SERVICE_AUTH_SECRET` **داخل حاوية الـAPI**
غير موجودة، أو فارغة/مسافات فقط، أو **أقصر من 32 بايت**. لا شيء آخر ينتجها (لا التوقيع، لا التطابق مع توكن المتصفح، لا قاعدة البيانات).

ما يعنيه ذلك:
1. الويب **يوقّع بنجاح** (الطلب وصل إلى الـAPI وسُجّل `GET /internal/v1/ping`)، فقيمة الويب صالحة (≥ 32 بايت).
2. قيمة الـAPI هي التي لا تجتاز الحدّ. اسم المتغير مطابق حرفيًا في الخدمتين، ولا تغييرات معلّقة (staged) في البيئة، ونشرا الخدمتين بعد ضبطه.
3. **الاقتباسات والمسافات والسطر الجديد لا تسبّب هذه الرسالة**: كلها تُطيل القيمة فتجتاز فحص الطول. تأثيرها الوحيد أن تختلف القيمتان بين الخدمتين
   فيظهر `service auth denied: bad signature` (401؛ في الصحة العامة `backend: rejected`)، وهذا مثبت باختبار.
4. لماذا لم يظهر قبل الدمج؟ الكود السابق على `main` كان **يتجاهل** هذا المتغير في الـAPI (المسبار غير موقَّع)، فلم تكن قيمته تُفحص أصلًا.
5. الرسالة القديمة لا تفرّق بين: غير موجود / فارغ / قصير. لذا أُضيف تشخيص بحدّ **التصنيف والمنطقيات فقط**.

## التشخيص دون كشف السر
بعد نشر الإصدار الذي يحوي التشخيص، يظهر عند إقلاع الـAPI سطر واحد:

```
service auth config: secret=<unset|empty|blank|below_minimum_length|ok> previous=<…> collides_with_browser_token=<True|False>
```
وعند كل 503: `no valid SERVICE_AUTH_SECRET (status=… edge_whitespace=… wrapped_in_quotes=… contains_newline=…)`.

| `status` | المعنى | الإجراء |
|---|---|---|
| `unset` | المتغير لم يصل إلى الحاوية | تأكد أنه في خدمة `safwan-api` نفسها (لا مشروع/بيئة أخرى) وأنه نُشر (Deploy) |
| `empty` / `blank` | وُجد بقيمة فارغة | أعد إدخال القيمة |
| `below_minimum_length` | أقل من 32 بايت | ولّد قيمة 64 hex (أدناه) |
| `ok` | الـAPI سليم | إن بقي 503 فالمشكلة في مكان آخر (القاعدة/`APP_DATABASE_URL`) |

الأعلام `edge_whitespace` و`wrapped_in_quotes` و`contains_newline` منطقية فقط؛ لا طول ولا قيمة في أي سطر (مثبت باختبار).

## الإصلاح (يتطلب إدخال سر جديد بيدك)
القيم Sealed لا تُقرأ، فالطريق الوحيد المضمون هو **إعادة الإدخال في الخدمتين معًا بقيمة واحدة جديدة**:

1. ولّد القيمة إلى الحافظة **دون سطر جديد**:
   `openssl rand -hex 32 | tr -d '\n' | pbcopy` (أو `xclip -selection clipboard`، أو PowerShell كما في `RAILWAY-PHASE3-DB-AUTH.md` §6.3). النتيجة 64 حرف hex.
2. `safwan-api` ← Variables ← `SERVICE_AUTH_SECRET` ← **Edit** (لا Raw Editor؛ لا يعدّل المتغيرات المحمية) ← الصق ← بلا اقتباسات ← احفظ ← Seal.
3. `@safwan/web` ← الأمر نفسه **بالحافظة نفسها** (لا تولّد قيمة ثانية).
4. اضغط **Deploy** لتطبيق التغييرات المعلّقة (المتغيرات تُطبَّق بنشر جديد فقط).
5. تحقق: `GET /api/health` ← 200 و`"backend":"ok"`. إن بقي 503 افحص سطر الإقلاع أعلاه (بعد نشر التشخيص).

## ما لا يجب فعله
- لا تعطّل فحص الطول أو التوقيع مؤقتًا لتجاوز 503.
- لا تقرأ القيمة من اللوحة أو عبر `list-variables` (تُظهر النص). يكفي التصنيف أعلاه.
- لا تستخدم `SERVICE_AUTH_SECRET_PREVIOUS` في الإعداد الأولي (للتدوير فقط).
