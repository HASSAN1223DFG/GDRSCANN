export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Only POST allowed' });
  }

  try {
    const { url } = req.body;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'Missing URL' });
    }

    let target = url.trim();

    // إضافة بروتوكول إذا مفقود
    if (!target.startsWith('http://') && !target.startsWith('https://')) {
      target = 'http://' + target;
    }

    let parsed;
    try {
      parsed = new URL(target);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    const full = parsed.href.toLowerCase();
    const host = parsed.hostname.toLowerCase();

    let score = 0;
    const reasons = [];

    // 1) https أو http
    if (parsed.protocol === 'https:') {
      score += 10;
      reasons.push('✅ الموقع يستخدم HTTPS (شيء إيجابي).');
    } else {
      score -= 20;
      reasons.push('⚠ الموقع لا يستخدم HTTPS، الاتصال غير مشفّر.');
    }

    // 2) طول الرابط
    if (full.length > 80 && full.length <= 140) {
      score -= 10;
      reasons.push('⚠ الرابط طويل نسبياً، قد يكون محاولة لإخفاء شيء.');
    } else if (full.length > 140) {
      score -= 25;
      reasons.push('🚨 الرابط طويل جداً، وهذا شائع في الروابط الاحتيالية.');
    } else {
      score += 5;
      reasons.push('✅ طول الرابط طبيعي.');
    }

    // 3) كثرة الأرقام
    const digits = full.replace(/[^0-9]/g, '').length;
    if (digits > 5 && digits <= 12) {
      score -= 10;
      reasons.push('⚠ يحتوي على الكثير من الأرقام في الرابط.');
    } else if (digits > 12) {
      score -= 20;
      reasons.push('🚨 عدد الأرقام مرتفع جداً، قد يكون مشبوهاً.');
    }

    // 4) استخدام IP بدلاً من اسم دومين
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
      score -= 30;
      reasons.push('🚨 الموقع يستخدم عنوان IP بدلاً من اسم نطاق، غالباً مشبوه.');
    }

    // 5) رمز @ في الرابط
    if (full.includes('@')) {
      score -= 25;
      reasons.push('🚨 وجود الرمز @ في الرابط قد يدل على إعادة توجيه خبيثة.');
    }

    // 6) امتدادات خطيرة شائعة
    const riskyTlds = [
      '.xyz','.top','.click','.gq','.ml','.cf','.tk',
      '.info','.work','.zip','.mov'
    ];
    const hasRiskyTld = riskyTlds.some(t => host.endsWith(t));
    if (hasRiskyTld) {
      score -= 15;
      reasons.push('⚠ امتداد النطاق من الأنواع التي تُستخدم كثيراً في الاحتيال والسبام.');
    }

    // 7) تشابه مع مواقع شهيرة
    const famous = ['facebook','google','paypal','microsoft','apple','amazon','instagram','bank','gov'];
    famous.forEach(name => {
      if (host.includes(name) && !host.endsWith(name + '.com')) {
        score -= 25;
        reasons.push(`🚨 يبدو أن الموقع يحاول تقليد موقع مشهور (${name}).`);
      }
    });

    // 8) محاولة جلب الصفحة (HTTP request) للحصول على العنوان والكود
    let httpInfo = {
      status: null,
      finalUrl: parsed.href,
      title: null
    };

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 7000); // 7 ثواني

      const resp = await fetch(parsed.href, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (URL Scanner)'
        }
      });

      clearTimeout(timeout);

      httpInfo.status = resp.status;
      httpInfo.finalUrl = resp.url;

      // نقرأ فقط حتى 50KB من الجسم لاستخراج العنوان
      const text = await resp.text();
      const short = text.slice(0, 50000);
      const m = short.match(/<title[^>]*>([^<]*)<\/title>/i);
      if (m) {
        httpInfo.title = m[1].trim();
      }

      // تحليل بسيط استناداً إلى الكود
      if (resp.status >= 400) {
        score -= 5;
        reasons.push(`⚠ الخادم أعاد كود خطأ HTTP ${resp.status}.`);
      } else if (resp.status >= 200 && resp.status < 300) {
        score += 5;
        reasons.push(`✅ الخادم استجاب بنجاح (HTTP ${resp.status}).`);
      }

      // كلمات مشبوهة في HTML
      const badWords = [
        'verify your account',
        'update your account',
        'login to continue',
        'confirm your password',
        'bank account',
        'credit card',
        'paypal',
        'free gift',
        'you won'
      ];
      let badFound = 0;
      const lowerHtml = short.toLowerCase();
      badWords.forEach(w => {
        if (lowerHtml.includes(w)) badFound++;
      });
      if (badFound > 0) {
        score -= 15;
        reasons.push(`🚨 تم العثور على ${badFound} عبارة مشبوهة في محتوى الصفحة.`);
      }

    } catch (e) {
      reasons.push('⚠ تعذر جلب الصفحة (قد يكون الموقع بطيئاً أو غير متاح).');
      score -= 5;
    }

    // تحديد مستوى الخطورة النهائي
    let riskLevel;
    if (score >= 10) {
      riskLevel = 'منخفض';
    } else if (score >= -20) {
      riskLevel = 'متوسط';
    } else {
      riskLevel = 'عالي';
    }

    return res.status(200).json({
      ok: true,
      url: parsed.href,
      host,
      riskScore: score,
      riskLevel,
      reasons,
      httpInfo
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
