// Countries offered in the "Deliver to" selector and address forms.
export const COUNTRIES = [
  ['SA', 'Saudi Arabia', 'السعودية'], ['AE', 'United Arab Emirates', 'الإمارات'], ['KW', 'Kuwait', 'الكويت'],
  ['BH', 'Bahrain', 'البحرين'], ['QA', 'Qatar', 'قطر'], ['OM', 'Oman', 'عُمان'], ['EG', 'Egypt', 'مصر'],
  ['JO', 'Jordan', 'الأردن'], ['LB', 'Lebanon', 'لبنان'], ['IQ', 'Iraq', 'العراق'], ['MA', 'Morocco', 'المغرب'],
  ['TN', 'Tunisia', 'تونس'], ['DZ', 'Algeria', 'الجزائر'], ['TR', 'Türkiye', 'تركيا'], ['PK', 'Pakistan', 'باكستان'],
  ['IN', 'India', 'الهند'], ['GB', 'United Kingdom', 'المملكة المتحدة'], ['DE', 'Germany', 'ألمانيا'],
  ['FR', 'France', 'فرنسا'], ['IT', 'Italy', 'إيطاليا'], ['ES', 'Spain', 'إسبانيا'], ['NL', 'Netherlands', 'هولندا'],
  ['SE', 'Sweden', 'السويد'], ['US', 'United States', 'الولايات المتحدة'], ['CA', 'Canada', 'كندا'],
  ['AU', 'Australia', 'أستراليا'], ['JP', 'Japan', 'اليابان'], ['MY', 'Malaysia', 'ماليزيا'], ['SG', 'Singapore', 'سنغافورة'],
  ['ID', 'Indonesia', 'إندونيسيا'], ['NG', 'Nigeria', 'نيجيريا'], ['ZA', 'South Africa', 'جنوب أفريقيا'], ['BR', 'Brazil', 'البرازيل'],
].map(([code, en, ar]) => ({ code, en, ar }));
