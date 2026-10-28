// English and Arabic interface text. Arabic switches the layout to right-to-left.

const en = {
  'nav.create': 'AI Create', 'nav.all': 'All products', 'nav.orders': 'Orders', 'nav.account': 'Account', 'nav.cart': 'Cart',
  'nav.signin': 'Sign in', 'nav.admin': 'Admin', 'nav.signout': 'Sign out', 'nav.lang': 'العربية',
  'deliver.to': 'Deliver to', 'deliver.title': 'Where should we deliver?', 'deliver.help': 'Prices include tax and shipping for this destination.',
  'deliver.region': 'State or region (optional)', 'deliver.save': 'Update prices', 'deliver.address': 'Use a saved address',
  'search.placeholder': 'Search vases, planters, chess pieces…', 'search.button': 'Search',
  'test.banner': 'Test mode: payments use test cards and printers are simulated.',

  'hero.title': 'Describe it. We print it and ship it.',
  'hero.lede': 'Type what you want. Our AI turns it into a 3D model you can spin and resize, then we print it in the material and colour you choose.',
  'hero.placeholder': 'a hexagonal pen holder shaped like a castle tower',
  'hero.cta': 'Create my model', 'hero.printing': 'Printing preview', 'hero.layer': 'layer',
  'home.categories': 'Shop by category', 'home.featured': 'Popular right now', 'home.best': 'Best sellers', 'home.seeAll': 'See all',
  'home.priceTitle': 'Every price, worked out in the open',
  'home.priceLede': 'There are no hidden costs. The price you see is the item, tax for your country, shipping to your door and our service fee, shown in your currency.',
  'home.feeSmall': 'Orders up to {amount}', 'home.feeLarge': 'Orders above {amount}', 'home.feeLabel': 'service fee',
  'home.example': 'Example: a pen holder delivered to {country}',

  'price.filament': 'Item price', 'price.tax': 'Tax', 'price.taxHint': '{rate}% for your country',
  'price.shipping': 'Shipping', 'price.shippingHint': '{zone}, {kg} kg billable', 'price.subtotal': 'Subtotal',
  'price.fee': 'Service fee', 'price.feeHint': '{pct}% of subtotal', 'price.total': 'Total',
  'price.delivered': 'delivered to {country}', 'price.includes': 'Includes tax, shipping and service fee',
  'price.noShip': "We don't ship to {country} yet.", 'price.days': 'Arrives in {min}–{max} days after printing',
  'price.from': 'Delivered price',

  'pdp.material': 'Material', 'pdp.color': 'Colour', 'pdp.size': 'Size', 'pdp.infill': 'Infill', 'pdp.quantity': 'Quantity',
  'pdp.infillHelp': 'How solid the inside is (30–40%). Higher is stronger and a little heavier.', 'pdp.add': 'Add to cart', 'pdp.added': 'Added to your cart',
  'pdp.wishlist': 'Save to wishlist', 'pdp.wishlisted': 'Saved to your wishlist', 'pdp.unwish': 'Remove from wishlist',
  'pdp.view3d': '3D', 'pdp.drag': 'Drag to rotate, scroll to zoom', 'pdp.previewNote': 'Preview only. Your item is printed at full detail.',
  'pdp.description': 'Description', 'pdp.details': 'Print details', 'pdp.reviews': 'Reviews', 'pdp.related': 'You may also like',
  'pdp.dimensions': 'Dimensions', 'pdp.weight': 'Estimated weight', 'pdp.printability': 'Printability', 'pdp.largest': 'Largest side',
  'pdp.writeReview': 'Write a review', 'pdp.reviewTitle': 'Title', 'pdp.reviewBody': 'Your review', 'pdp.submitReview': 'Post review',
  'pdp.reviewThanks': 'Thanks! Your review is posted.', 'pdp.verified': 'Verified purchase', 'pdp.noReviews': 'No reviews yet. Be the first after your order arrives.',
  'pdp.ratings': '{n} ratings', 'pdp.signinReview': 'Sign in to write a review.', 'pdp.supports': 'Printed with supports; small marks may remain under overhangs.',
  'pdp.heat': 'Heat resistance', 'pdp.fragile': 'This shape has thin parts and may break if dropped. A larger size is sturdier.',
  'safety.title': 'Not for food or drink.', 'safety.text': 'Do not microwave, bake, or dishwash. Heat-resistant up to ~85°C (ABS) / ~100°C (ASA). Keep away from open flame.',
  'pay.card': 'Pay by card (Visa, Mastercard, Apple Pay)', 'pay.waiting': 'Waiting for your payment…', 'pay.redirecting': 'Taking you to the secure payment page…', 'pay.failed': 'The payment did not go through. You can try again.',
  'pdp.sold': '{n} sold',

  'check.watertight': 'Watertight', 'check.bed': 'Fits our printer (max 250 mm)', 'check.min_size': 'Big enough to print', 'check.supports': 'Supports', 'check.walls': 'Walls at least 2 mm', 'check.shape': 'Sturdy shape',
  'check.supportsNo': 'No supports needed', 'check.supportsYes': 'Needs supports (included in the price)', 'check.maxSize': 'Use the largest size that fits',

  'create.title': 'AI Create', 'create.lede': 'Describe an object. You can change the prompt, regenerate, and adjust size, material, colour and infill before you buy.',
  'create.prompt': 'Describe your object', 'create.generate': 'Generate model', 'create.regenerate': 'Regenerate', 'create.edit': 'Generate from edited prompt',
  'create.examples': 'Try one of these', 'create.versions': 'Your versions', 'create.generating': 'Shaping your model…',
  'create.generatingHint': 'Usually a few seconds; detailed AI models can take 1–3 minutes.',
  'create.empty': 'Your model appears here', 'create.emptyHint': 'Write a prompt on the left and press Generate.',
  'create.failed': 'This one did not work', 'create.privacy': 'The model file stays on our servers and is only sent to our printers. You get the printed item, not the file.',
  'create.sizeMm': 'Largest side (mm)', 'create.scale': 'Scale', 'create.provider': '{name}', 'create.signinToSave': 'Your designs are saved on this device. Sign in to keep them in your account.',
  'create.adjust': 'Adjust', 'create.history': 'Recent designs', 'create.notPrintable': 'Fix the problem shown in red before adding to cart.',

  'cart.title': 'Your cart', 'cart.empty': 'Your cart is empty', 'cart.emptyHint': 'Browse the shop or create something new with AI.',
  'cart.remove': 'Remove', 'cart.checkout': 'Go to checkout', 'cart.summary': 'Order summary', 'cart.items': '{n} items',
  'cart.aiDesign': 'AI design', 'cart.problem': 'Needs attention', 'cart.signinCheckout': 'Sign in to check out',

  'checkout.title': 'Checkout', 'checkout.address': 'Delivery address', 'checkout.addAddress': 'Add a new address', 'checkout.review': 'Review and pay',
  'checkout.place': 'Place order and pay {total}', 'checkout.paidNote': 'Printing starts only after your payment is confirmed.',
  'pay.title': 'Payment', 'pay.testMode': 'Test mode: no real money is charged.', 'pay.cardNumber': 'Card number', 'pay.expiry': 'Expiry (MM/YY)',
  'pay.cvc': 'Security code', 'pay.name': 'Name on card', 'pay.pay': 'Pay {total}', 'pay.testCards': 'Test cards: 4242 4242 4242 4242 (approved), 4000 0000 0000 0002 (declined).',
  'pay.stripe': 'Continue to secure payment', 'pay.success': 'Payment confirmed. Your order is in the print queue.', 'pay.awaiting': 'Awaiting payment',
  'pay.payNow': 'Pay now', 'pay.cancelled': 'Payment was cancelled. You can try again.',
  'pay.unconfigured': "Payments aren't set up yet, so this order can't be paid. Please try again later.",

  'orders.title': 'Your orders', 'orders.empty': 'No orders yet', 'orders.emptyHint': 'When you order, you can follow every step of the printing here.',
  'order.title': 'Order {number}', 'order.placed': 'Placed {date}', 'order.items': 'Items', 'order.track': 'Tracking', 'order.shipTo': 'Ship to',
  'order.payment': 'Payment', 'order.tracking': 'Tracking number', 'order.copy': 'Copy {n}', 'order.refunded': 'Refunded {amount}',
  'order.live': 'Updates automatically',

  'status.pending_payment': 'Awaiting payment', 'status.paid': 'Paid', 'status.in_queue': 'In print queue', 'status.printing': 'Printing',
  'status.printed': 'Printed', 'status.packed': 'Packed', 'status.shipped': 'Shipped', 'status.delivered': 'Delivered',
  'status.cancelled': 'Cancelled', 'status.refunded': 'Refunded',
  'job.queued': 'Waiting', 'job.slicing': 'Preparing print file', 'job.ready': 'In queue', 'job.printing': 'Printing', 'job.paused': 'Paused',
  'job.printed': 'Printed', 'job.failed': 'Reprinting soon', 'job.cancelled': 'Cancelled',
  'pstatus.idle': 'Idle', 'pstatus.printing': 'Printing', 'pstatus.paused': 'Paused', 'pstatus.awaiting_clear': 'Clear the bed',
  'pstatus.error': 'Error', 'pstatus.offline': 'Offline',

  'account.title': 'Your account', 'account.profile': 'Profile', 'account.addresses': 'Addresses', 'account.wishlist': 'Wishlist', 'account.designs': 'My AI designs',
  'account.orders': 'Orders', 'account.name': 'Name', 'account.email': 'Email', 'account.language': 'Language', 'account.save': 'Save changes',
  'account.saved': 'Changes saved', 'account.password': 'Change password', 'account.current': 'Current password', 'account.new': 'New password',
  'account.makeDefault': 'Make default', 'account.default': 'Default', 'account.delete': 'Delete', 'account.edit': 'Edit',
  'account.noAddresses': 'No saved addresses yet.', 'account.noWishlist': 'Nothing saved yet. Tap the heart on any product.',
  'account.noDesigns': 'No designs yet.',
  'addr.fullName': 'Full name', 'addr.phone': 'Phone', 'addr.line1': 'Street and building', 'addr.line2': 'Apartment, floor (optional)',
  'addr.city': 'City', 'addr.region': 'Region or state', 'addr.postal': 'Postal code', 'addr.country': 'Country', 'addr.label': 'Label (Home, Work…)',
  'addr.save': 'Save address',

  'auth.signin': 'Sign in', 'auth.signup': 'Create account', 'auth.email': 'Email', 'auth.password': 'Password', 'auth.name': 'Your name',
  'auth.noAccount': 'New to Prompt2Print?', 'auth.haveAccount': 'Already have an account?',
  'auth.passwordHint': 'At least 8 characters', 'auth.welcome': 'Welcome, {name}',
  'auth.badLogin': 'Email or password is incorrect.', 'auth.emailTaken': 'An account with this email already exists. Sign in instead.', 'auth.confirmEmail': 'Confirm your email first: open the link we sent you, then sign in.',
  'auth.tooMany': 'Too many attempts. Wait a minute and try again.', 'auth.nameRequired': 'Enter your name.', 'auth.disabled': 'This account is disabled. Contact support.',
  'auth.checkInbox': 'Check your inbox', 'auth.checkInboxHint': 'We sent a confirmation link to {email}. Open it, then sign in.',

  'search.results': '{n} results for “{q}”', 'search.all': 'All products', 'search.none': 'Nothing matched', 'search.noneHint': 'Try another word, or describe it in AI Create and we will make it.',
  'sort.label': 'Sort by', 'sort.featured': 'Featured', 'sort.price_asc': 'Price: low to high', 'sort.price_desc': 'Price: high to low',
  'sort.rating': 'Top rated', 'sort.newest': 'Newest', 'sort.bestselling': 'Best selling',

  'common.loading': 'Loading…', 'common.cancel': 'Cancel', 'common.save': 'Save', 'common.close': 'Close', 'common.back': 'Back',
  'common.error': 'Something went wrong.', 'common.retry': 'Try again', 'common.notFound': 'Page not found', 'common.home': 'Go to the home page',
  'common.mm': 'mm', 'common.g': 'g', 'common.yes': 'Yes', 'common.no': 'No', 'common.offline': 'Prompt2Print could not reach the shop. Check your internet connection.',
  'check.printable': 'Printable', 'check.notPrintable': 'Not printable',
  'footer.tag': 'AI-designed objects, printed to order and shipped to you.', 'footer.shop': 'Shop', 'footer.help': 'Help', 'footer.company': 'Prompt2Print',
  'footer.pricing': 'How pricing works', 'footer.privacy': 'Your model files stay private', 'footer.track': 'Track an order',
};

const ar = {
  'nav.create': 'صمّم بالذكاء الاصطناعي', 'nav.all': 'كل المنتجات', 'nav.orders': 'الطلبات', 'nav.account': 'حسابي', 'nav.cart': 'السلة',
  'nav.signin': 'تسجيل الدخول', 'nav.admin': 'الإدارة', 'nav.signout': 'تسجيل الخروج', 'nav.lang': 'English',
  'deliver.to': 'التوصيل إلى', 'deliver.title': 'إلى أين نوصل طلبك؟', 'deliver.help': 'الأسعار تشمل الضريبة والشحن لهذه الوجهة.',
  'deliver.region': 'المنطقة أو الولاية (اختياري)', 'deliver.save': 'تحديث الأسعار', 'deliver.address': 'استخدم عنواناً محفوظاً',
  'search.placeholder': 'ابحث عن مزهريات، أصص، قطع شطرنج…', 'search.button': 'بحث',
  'test.banner': 'وضع التجربة: الدفع ببطاقات تجريبية والطابعات محاكاة.',

  'hero.title': 'صِف الشيء، ونحن نطبعه ونوصله لك.',
  'hero.lede': 'اكتب ما تريد، وسيحوّله الذكاء الاصطناعي إلى نموذج ثلاثي الأبعاد تديره وتغيّر حجمه، ثم نطبعه بالخامة واللون اللذين تختارهما.',
  'hero.placeholder': 'حامل أقلام سداسي على شكل برج قلعة',
  'hero.cta': 'أنشئ نموذجي', 'hero.printing': 'معاينة الطباعة', 'hero.layer': 'طبقة',
  'home.categories': 'تسوّق حسب الفئة', 'home.featured': 'الأكثر طلباً الآن', 'home.best': 'الأكثر مبيعاً', 'home.seeAll': 'عرض الكل',
  'home.priceTitle': 'كل سعر محسوب أمامك بوضوح',
  'home.priceLede': 'لا توجد تكاليف مخفية. السعر الذي تراه هو القطعة والضريبة حسب دولتك والشحن إلى بابك ورسوم الخدمة، بعملتك.',
  'home.feeSmall': 'الطلبات حتى {amount}', 'home.feeLarge': 'الطلبات فوق {amount}', 'home.feeLabel': 'رسوم خدمة',
  'home.example': 'مثال: حامل أقلام يُوصّل إلى {country}',

  'price.filament': 'سعر القطعة', 'price.tax': 'الضريبة', 'price.taxHint': '{rate}% حسب دولتك',
  'price.shipping': 'الشحن', 'price.shippingHint': '{zone}، {kg} كغ محسوبة', 'price.subtotal': 'المجموع الفرعي',
  'price.fee': 'رسوم الخدمة', 'price.feeHint': '{pct}% من المجموع الفرعي', 'price.total': 'الإجمالي',
  'price.delivered': 'شاملاً التوصيل إلى {country}', 'price.includes': 'يشمل الضريبة والشحن ورسوم الخدمة',
  'price.noShip': 'لا نشحن إلى {country} حالياً.', 'price.days': 'يصل خلال {min}–{max} أيام بعد الطباعة',
  'price.from': 'السعر شاملاً التوصيل',

  'pdp.material': 'الخامة', 'pdp.color': 'اللون', 'pdp.size': 'الحجم', 'pdp.infill': 'نسبة الحشو', 'pdp.quantity': 'الكمية',
  'pdp.infillHelp': 'مدى صلابة الداخل (30–40%). النسبة الأعلى أقوى وأثقل قليلاً.', 'pdp.add': 'أضف إلى السلة', 'pdp.added': 'أُضيف إلى سلتك',
  'pdp.wishlist': 'احفظ في المفضلة', 'pdp.wishlisted': 'حُفظ في المفضلة', 'pdp.unwish': 'إزالة من المفضلة',
  'pdp.view3d': '3D', 'pdp.drag': 'اسحب للتدوير، ومرّر للتكبير', 'pdp.previewNote': 'معاينة فقط. تُطبع قطعتك بكامل التفاصيل.',
  'pdp.description': 'الوصف', 'pdp.details': 'تفاصيل الطباعة', 'pdp.reviews': 'التقييمات', 'pdp.related': 'قد يعجبك أيضاً',
  'pdp.dimensions': 'الأبعاد', 'pdp.weight': 'الوزن التقديري', 'pdp.printability': 'قابلية الطباعة', 'pdp.largest': 'أطول ضلع',
  'pdp.writeReview': 'اكتب تقييماً', 'pdp.reviewTitle': 'العنوان', 'pdp.reviewBody': 'تقييمك', 'pdp.submitReview': 'انشر التقييم',
  'pdp.reviewThanks': 'شكراً! نُشر تقييمك.', 'pdp.verified': 'شراء مؤكد', 'pdp.noReviews': 'لا توجد تقييمات بعد. كن أول من يقيّم بعد وصول طلبك.',
  'pdp.ratings': '{n} تقييم', 'pdp.signinReview': 'سجّل الدخول لكتابة تقييم.', 'pdp.supports': 'تُطبع مع دعامات، وقد تبقى علامات صغيرة تحت الأجزاء البارزة.',
  'pdp.heat': 'مقاومة الحرارة', 'pdp.fragile': 'هذا الشكل فيه أجزاء رفيعة وقد ينكسر إذا سقط. الحجم الأكبر أمتن.',
  'safety.title': 'ليس للطعام أو الشراب.', 'safety.text': 'لا تضعه في الميكروويف أو الفرن أو غسالة الصحون. يتحمل الحرارة حتى ~85° (ABS) / ~100° (ASA). أبعده عن اللهب.',
  'pay.card': 'ادفع بالبطاقة (فيزا، ماستركارد، Apple Pay)', 'pay.waiting': 'بانتظار إتمام الدفع…', 'pay.redirecting': 'جارٍ تحويلك إلى صفحة الدفع الآمنة…', 'pay.failed': 'لم تتم عملية الدفع. يمكنك المحاولة مرة أخرى.',
  'pdp.sold': 'بيع {n}',

  'check.watertight': 'نموذج مغلق ومحكم', 'check.bed': 'يناسب طابعتنا (حتى 250 مم)', 'check.min_size': 'حجم كافٍ للطباعة', 'check.supports': 'الدعامات', 'check.walls': 'جدران لا تقل عن 2 مم', 'check.shape': 'شكل متين',
  'check.supportsNo': 'لا يحتاج دعامات', 'check.supportsYes': 'يحتاج دعامات (مشمولة في السعر)', 'check.maxSize': 'استخدم أكبر حجم مناسب',

  'create.title': 'صمّم بالذكاء الاصطناعي', 'create.lede': 'صِف الشيء الذي تريده. يمكنك تعديل الوصف وإعادة الإنشاء وضبط الحجم والخامة واللون ونسبة الحشو قبل الشراء.',
  'create.prompt': 'صِف الشيء الذي تريده', 'create.generate': 'أنشئ النموذج', 'create.regenerate': 'أعد الإنشاء', 'create.edit': 'أنشئ من الوصف المعدّل',
  'create.examples': 'جرّب أحد هذه الأمثلة', 'create.versions': 'نسخك', 'create.generating': 'نُشكّل نموذجك…',
  'create.generatingHint': 'عادةً ثوانٍ قليلة؛ النماذج المفصّلة بالذكاء الاصطناعي قد تستغرق من دقيقة إلى ثلاث.',
  'create.empty': 'سيظهر نموذجك هنا', 'create.emptyHint': 'اكتب وصفاً ثم اضغط «أنشئ النموذج».',
  'create.failed': 'لم ينجح هذا التصميم', 'create.privacy': 'يبقى ملف النموذج على خوادمنا ويُرسل إلى طابعاتنا فقط. تحصل على القطعة المطبوعة وليس الملف.',
  'create.sizeMm': 'أطول ضلع (مم)', 'create.scale': 'المقياس', 'create.provider': '{name}', 'create.signinToSave': 'تصاميمك محفوظة على هذا الجهاز. سجّل الدخول لحفظها في حسابك.',
  'create.adjust': 'التعديل', 'create.history': 'تصاميم حديثة', 'create.notPrintable': 'عالج المشكلة الظاهرة بالأحمر قبل الإضافة إلى السلة.',

  'cart.title': 'سلتك', 'cart.empty': 'سلتك فارغة', 'cart.emptyHint': 'تصفّح المتجر أو صمّم شيئاً جديداً بالذكاء الاصطناعي.',
  'cart.remove': 'إزالة', 'cart.checkout': 'إتمام الشراء', 'cart.summary': 'ملخص الطلب', 'cart.items': '{n} قطع',
  'cart.aiDesign': 'تصميم بالذكاء الاصطناعي', 'cart.problem': 'يحتاج انتباهك', 'cart.signinCheckout': 'سجّل الدخول لإتمام الشراء',

  'checkout.title': 'إتمام الشراء', 'checkout.address': 'عنوان التوصيل', 'checkout.addAddress': 'أضف عنواناً جديداً', 'checkout.review': 'المراجعة والدفع',
  'checkout.place': 'أكّد الطلب وادفع {total}', 'checkout.paidNote': 'لا تبدأ الطباعة إلا بعد تأكيد الدفع.',
  'pay.title': 'الدفع', 'pay.testMode': 'وضع التجربة: لن يُخصم أي مبلغ حقيقي.', 'pay.cardNumber': 'رقم البطاقة', 'pay.expiry': 'تاريخ الانتهاء (MM/YY)',
  'pay.cvc': 'رمز الأمان', 'pay.name': 'الاسم على البطاقة', 'pay.pay': 'ادفع {total}', 'pay.testCards': 'بطاقات تجريبية: 4242 4242 4242 4242 (مقبولة)، 4000 0000 0000 0002 (مرفوضة).',
  'pay.stripe': 'المتابعة إلى الدفع الآمن', 'pay.success': 'تم تأكيد الدفع. طلبك في قائمة الطباعة.', 'pay.awaiting': 'بانتظار الدفع',
  'pay.payNow': 'ادفع الآن', 'pay.cancelled': 'أُلغي الدفع. يمكنك المحاولة مرة أخرى.',
  'pay.unconfigured': 'لم يتم إعداد الدفع بعد، لذلك لا يمكن دفع هذا الطلب. حاول لاحقاً.',

  'orders.title': 'طلباتك', 'orders.empty': 'لا توجد طلبات بعد', 'orders.emptyHint': 'عندما تطلب، يمكنك متابعة كل مراحل الطباعة هنا.',
  'order.title': 'الطلب {number}', 'order.placed': 'بتاريخ {date}', 'order.items': 'القطع', 'order.track': 'التتبع', 'order.shipTo': 'الشحن إلى',
  'order.payment': 'الدفع', 'order.tracking': 'رقم التتبع', 'order.copy': 'النسخة {n}', 'order.refunded': 'تم استرداد {amount}',
  'order.live': 'يتحدث تلقائياً',

  'status.pending_payment': 'بانتظار الدفع', 'status.paid': 'مدفوع', 'status.in_queue': 'في قائمة الطباعة', 'status.printing': 'قيد الطباعة',
  'status.printed': 'تمت الطباعة', 'status.packed': 'تم التغليف', 'status.shipped': 'تم الشحن', 'status.delivered': 'تم التوصيل',
  'status.cancelled': 'ملغي', 'status.refunded': 'مسترد',
  'job.queued': 'بالانتظار', 'job.slicing': 'تجهيز ملف الطباعة', 'job.ready': 'في القائمة', 'job.printing': 'قيد الطباعة', 'job.paused': 'متوقف مؤقتاً',
  'job.printed': 'تمت الطباعة', 'job.failed': 'ستُعاد الطباعة قريباً', 'job.cancelled': 'ملغي',
  'pstatus.idle': 'جاهزة', 'pstatus.printing': 'تطبع', 'pstatus.paused': 'متوقفة مؤقتاً', 'pstatus.awaiting_clear': 'أفرغ السطح',
  'pstatus.error': 'خطأ', 'pstatus.offline': 'غير متصلة',

  'account.title': 'حسابك', 'account.profile': 'الملف الشخصي', 'account.addresses': 'العناوين', 'account.wishlist': 'المفضلة', 'account.designs': 'تصاميمي',
  'account.orders': 'الطلبات', 'account.name': 'الاسم', 'account.email': 'البريد الإلكتروني', 'account.language': 'اللغة', 'account.save': 'حفظ التغييرات',
  'account.saved': 'تم حفظ التغييرات', 'account.password': 'تغيير كلمة المرور', 'account.current': 'كلمة المرور الحالية', 'account.new': 'كلمة المرور الجديدة',
  'account.makeDefault': 'اجعله افتراضياً', 'account.default': 'افتراضي', 'account.delete': 'حذف', 'account.edit': 'تعديل',
  'account.noAddresses': 'لا توجد عناوين محفوظة بعد.', 'account.noWishlist': 'لا يوجد شيء محفوظ بعد. اضغط على القلب في أي منتج.',
  'account.noDesigns': 'لا توجد تصاميم بعد.',
  'addr.fullName': 'الاسم الكامل', 'addr.phone': 'الجوال', 'addr.line1': 'الشارع والمبنى', 'addr.line2': 'الشقة أو الدور (اختياري)',
  'addr.city': 'المدينة', 'addr.region': 'المنطقة أو الولاية', 'addr.postal': 'الرمز البريدي', 'addr.country': 'الدولة', 'addr.label': 'الاسم (المنزل، العمل…)',
  'addr.save': 'حفظ العنوان',

  'auth.signin': 'تسجيل الدخول', 'auth.signup': 'إنشاء حساب', 'auth.email': 'البريد الإلكتروني', 'auth.password': 'كلمة المرور', 'auth.name': 'اسمك',
  'auth.noAccount': 'جديد على Prompt2Print؟', 'auth.haveAccount': 'لديك حساب بالفعل؟',
  'auth.passwordHint': '8 أحرف على الأقل', 'auth.welcome': 'أهلاً، {name}',
  'auth.badLogin': 'البريد الإلكتروني أو كلمة المرور غير صحيحة.', 'auth.emailTaken': 'يوجد حساب بهذا البريد بالفعل. سجّل الدخول بدلاً من ذلك.', 'auth.confirmEmail': 'أكّد بريدك أولاً: افتح الرابط الذي أرسلناه لك ثم سجّل الدخول.',
  'auth.tooMany': 'محاولات كثيرة. انتظر دقيقة وحاول مرة أخرى.', 'auth.nameRequired': 'اكتب اسمك.', 'auth.disabled': 'هذا الحساب معطّل. تواصل مع الدعم.',
  'auth.checkInbox': 'تحقق من بريدك', 'auth.checkInboxHint': 'أرسلنا رابط تأكيد إلى {email}. افتحه ثم سجّل الدخول.',

  'search.results': '{n} نتيجة لـ «{q}»', 'search.all': 'كل المنتجات', 'search.none': 'لا توجد نتائج', 'search.noneHint': 'جرّب كلمة أخرى، أو صِفه في «صمّم بالذكاء الاصطناعي» وسنصنعه لك.',
  'sort.label': 'ترتيب حسب', 'sort.featured': 'المميزة', 'sort.price_asc': 'السعر: من الأقل', 'sort.price_desc': 'السعر: من الأعلى',
  'sort.rating': 'الأعلى تقييماً', 'sort.newest': 'الأحدث', 'sort.bestselling': 'الأكثر مبيعاً',

  'common.loading': 'جارٍ التحميل…', 'common.cancel': 'إلغاء', 'common.save': 'حفظ', 'common.close': 'إغلاق', 'common.back': 'رجوع',
  'common.error': 'حدث خطأ ما.', 'common.retry': 'حاول مرة أخرى', 'common.notFound': 'الصفحة غير موجودة', 'common.home': 'العودة إلى الصفحة الرئيسية',
  'common.mm': 'مم', 'common.g': 'غ', 'common.yes': 'نعم', 'common.no': 'لا', 'common.offline': 'تعذّر الوصول إلى المتجر. تحقق من اتصالك بالإنترنت.',
  'check.printable': 'قابل للطباعة', 'check.notPrintable': 'غير قابل للطباعة',
  'footer.tag': 'قطع مصممة بالذكاء الاصطناعي، تُطبع حسب الطلب وتُشحن إليك.', 'footer.shop': 'المتجر', 'footer.help': 'المساعدة', 'footer.company': 'Prompt2Print',
  'footer.pricing': 'كيف نحسب السعر', 'footer.privacy': 'ملفات نماذجك تبقى خاصة', 'footer.track': 'تتبّع طلباً',
};

const dicts = { en, ar };
let locale = 'en';

export function setLocale(l) {
  locale = l === 'ar' ? 'ar' : 'en';
  document.documentElement.lang = locale;
  document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
}
export const getLocale = () => locale;
export const isAr = () => locale === 'ar';

export function t(key, params = {}) {
  let s = dicts[locale][key] ?? en[key] ?? key;
  for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, v);
  return s;
}

// Pick the right language from a { en, ar } object.
export function tr(obj) {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  return obj[locale] || obj.en || '';
}
