-- Prompt2Print — Supabase schema (v2: cloud backend shared by all apps)
-- Money is stored in integer halalas (SAR cents). Row Level Security is on everywhere.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- helpers
create or replace function public.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- ---------------------------------------------------------------- profiles (one per auth user)
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  name text not null default '',
  role text not null default 'customer' check (role in ('customer', 'admin')),
  locale text not null default 'en' check (locale in ('en', 'ar')),
  disabled boolean not null default false,
  created_at timestamptz not null default now()
);
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin' and not disabled from public.profiles where id = auth.uid()), false);
$$;

alter table public.profiles enable row level security;
create policy "own profile" on public.profiles for select using (id = auth.uid() or public.is_admin());
create policy "update own profile" on public.profiles for update using (id = auth.uid())
  with check (id = auth.uid() and role = (select role from public.profiles p where p.id = auth.uid()) and disabled = false);
create policy "admin updates profiles" on public.profiles for update using (public.is_admin());

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(id, email, name, locale)
  values (new.id, lower(new.email), coalesce(new.raw_user_meta_data->>'name', ''), coalesce(new.raw_user_meta_data->>'locale', 'en'))
  on conflict (id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------- settings, currencies, taxes, shipping
create table public.settings (key text primary key, value jsonb not null, updated_at timestamptz not null default now());
alter table public.settings enable row level security;
create policy "public settings" on public.settings for select using (key not like 'secret:%');
create policy "admin settings" on public.settings for all using (public.is_admin()) with check (public.is_admin());

create table public.currencies (
  code text primary key, name text not null, rate numeric not null check (rate > 0), decimals int not null default 2, sort int not null default 0
);
create table public.country_currency (country text primary key, currency text not null references public.currencies(code));
create table public.tax_rates (
  id serial primary key, country text not null, region text not null default '*', rate numeric not null default 0, label text not null default '',
  unique (country, region)
);
create table public.shipping_zones (
  id serial primary key, name_en text not null, name_ar text not null, countries jsonb not null default '[]',
  base_cents int not null, per_kg_cents int not null, volumetric_divisor int not null default 5000,
  min_days int not null default 3, max_days int not null default 7, active boolean not null default true, sort int not null default 0
);
alter table public.currencies enable row level security;
alter table public.country_currency enable row level security;
alter table public.tax_rates enable row level security;
alter table public.shipping_zones enable row level security;
create policy "read currencies" on public.currencies for select using (true);
create policy "read country_currency" on public.country_currency for select using (true);
create policy "read tax_rates" on public.tax_rates for select using (true);
create policy "read shipping_zones" on public.shipping_zones for select using (true);
create policy "admin currencies" on public.currencies for all using (public.is_admin()) with check (public.is_admin());
create policy "admin country_currency" on public.country_currency for all using (public.is_admin()) with check (public.is_admin());
create policy "admin tax_rates" on public.tax_rates for all using (public.is_admin()) with check (public.is_admin());
create policy "admin shipping_zones" on public.shipping_zones for all using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------- catalog
create table public.categories (
  id serial primary key, slug text not null unique, name_en text not null, name_ar text not null, sort int not null default 0
);
create table public.materials (
  code text primary key, name_en text not null, name_ar text not null, desc_en text not null default '', desc_ar text not null default '',
  price_per_gram numeric not null, density numeric not null, process text not null default 'fdm',
  nozzle_temp int not null, bed_temp int not null, max_temp_c int not null default 85,
  colors jsonb not null default '[]',   -- [{code,name_en,name_ar,hex,in_stock}]
  active boolean not null default true, sort int not null default 0
);
create table public.models (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('catalog', 'ai', 'upload')),
  owner_id uuid references public.profiles(id) on delete set null,
  stl_path text not null,            -- storage: models/<id>.stl (private)
  preview_path text,                 -- storage: models/<id>.p2pv (private, reduced mesh)
  thumb_url text,                    -- public media url
  analysis jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create table public.products (
  id serial primary key, slug text not null unique,
  category_id int references public.categories(id) on delete set null,
  model_id uuid not null references public.models(id),
  name_en text not null, name_ar text not null, desc_en text not null default '', desc_ar text not null default '',
  default_material text not null references public.materials(code), default_color text not null,
  allowed_materials jsonb not null default '["ABS","ASA"]',
  default_scale numeric not null default 1, min_scale numeric not null default 0.5, max_scale numeric not null default 2,
  default_infill int not null default 35, images jsonb not null default '[]', tags text not null default '',
  featured boolean not null default false, active boolean not null default true, sold_count int not null default 0,
  created_at timestamptz not null default now()
);
create table public.reviews (
  id serial primary key, product_id int not null references public.products(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade, rating int not null check (rating between 1 and 5),
  text text not null default '', created_at timestamptz not null default now(), unique (product_id, user_id)
);
create table public.wishlist (
  user_id uuid not null references public.profiles(id) on delete cascade, product_id int not null references public.products(id) on delete cascade,
  created_at timestamptz not null default now(), primary key (user_id, product_id)
);
alter table public.categories enable row level security;
alter table public.materials enable row level security;
alter table public.models enable row level security;
alter table public.products enable row level security;
alter table public.reviews enable row level security;
alter table public.wishlist enable row level security;
create policy "read categories" on public.categories for select using (true);
create policy "read materials" on public.materials for select using (active or public.is_admin());
create policy "read products" on public.products for select using (active or public.is_admin());
create policy "read own or catalog models" on public.models for select
  using (owner_id = auth.uid() or source = 'catalog' or public.is_admin());
create policy "read reviews" on public.reviews for select using (true);
create policy "write own review" on public.reviews for insert with check (user_id = auth.uid());
create policy "delete own review" on public.reviews for delete using (user_id = auth.uid() or public.is_admin());
create policy "own wishlist" on public.wishlist for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "admin categories" on public.categories for all using (public.is_admin()) with check (public.is_admin());
create policy "admin materials" on public.materials for all using (public.is_admin()) with check (public.is_admin());
create policy "admin products" on public.products for all using (public.is_admin()) with check (public.is_admin());
create policy "admin models" on public.models for all using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------- AI designs
create table public.designs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  prompt text not null, seed int not null default 1, parent_id uuid references public.designs(id) on delete set null,
  status text not null default 'queued' check (status in ('queued', 'generating', 'ready', 'failed')),
  progress int not null default 0, provider text not null default 'tripo', provider_task_id text,
  title_en text, title_ar text, thumb_url text, model_id uuid references public.models(id), error text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create trigger designs_updated before update on public.designs for each row execute function public.set_updated_at();
alter table public.designs enable row level security;
create policy "own designs" on public.designs for select using (user_id = auth.uid() or public.is_admin());
create index designs_user_idx on public.designs(user_id, created_at desc);

-- ---------------------------------------------------------------- addresses
create table public.addresses (
  id serial primary key, user_id uuid not null references public.profiles(id) on delete cascade,
  label text not null default '', full_name text not null, phone text not null default '', line1 text not null, line2 text not null default '',
  city text not null, region text not null default '', postal_code text not null default '', country text not null,
  is_default boolean not null default false, created_at timestamptz not null default now()
);
alter table public.addresses enable row level security;
create policy "own addresses" on public.addresses for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "admin reads addresses" on public.addresses for select using (public.is_admin());

-- ---------------------------------------------------------------- orders
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  user_id uuid not null references public.profiles(id),
  status text not null default 'pending_payment' check (status in
    ('pending_payment', 'paid', 'in_queue', 'printing', 'printed', 'packed', 'shipped', 'delivered', 'cancelled', 'refunded', 'failed')),
  country text not null, region text not null default '', address jsonb not null,
  pricing jsonb not null,                 -- breakdown in halalas
  total_cents int not null, display_currency text not null default 'SAR', fx_rate numeric not null default 1, charged_amount numeric,
  payment jsonb not null default '{}',    -- provider, reference, charged
  refunded_cents int not null default 0,
  tracking jsonb not null default '{}',   -- carrier, number, url
  notes text not null default '',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), paid_at timestamptz
);
create trigger orders_updated before update on public.orders for each row execute function public.set_updated_at();
create table public.order_items (
  id serial primary key, order_id uuid not null references public.orders(id) on delete cascade,
  product_id int references public.products(id), design_id uuid references public.designs(id), model_id uuid not null references public.models(id),
  title_en text not null, title_ar text not null, material text not null, color text not null,
  scale numeric not null default 1, infill int not null default 35, quantity int not null default 1,
  size_mm jsonb not null default '[]', weight_g numeric not null default 0, print_time_sec int not null default 0,
  filament_cents int not null, thumb_url text
);
create table public.order_events (
  id serial primary key, order_id uuid not null references public.orders(id) on delete cascade,
  status text not null, detail text not null default '', created_at timestamptz not null default now()
);
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.order_events enable row level security;
create policy "own orders" on public.orders for select using (user_id = auth.uid() or public.is_admin());
create policy "own order items" on public.order_items for select
  using (exists (select 1 from public.orders o where o.id = order_id and (o.user_id = auth.uid() or public.is_admin())));
create policy "own order events" on public.order_events for select
  using (exists (select 1 from public.orders o where o.id = order_id and (o.user_id = auth.uid() or public.is_admin())));
create policy "admin orders" on public.orders for update using (public.is_admin());
create index orders_user_idx on public.orders(user_id, created_at desc);
create index orders_status_idx on public.orders(status);

-- ---------------------------------------------------------------- printers and print jobs
create table public.printer_types (
  code text primary key, vendor text not null, name text not null, driver text not null,    -- bambu | moonraker | octoprint
  bed jsonb not null,                 -- {x,y,z} mm
  nozzle_mm numeric not null default 0.4, max_nozzle_c int not null, max_bed_c int not null, enclosed boolean not null default false,
  slots int not null default 1,       -- AMS / multi-material slots
  slicer_app text not null, slicer_url text not null, slicer_printer_profile text not null default '', slicer_process_profile text not null default '',
  notes_en text not null default '', notes_ar text not null default '', sort int not null default 0
);
create table public.printers (
  id serial primary key, name text not null, type_code text not null references public.printer_types(code),
  address text not null default '', serial text not null default '', access_code text not null default '',
  nozzle_mm numeric not null default 0.4, materials jsonb not null default '["ABS","ASA"]',
  slots jsonb not null default '[]',  -- [{slot, material, color}]
  active boolean not null default false, status text not null default 'offline', status_detail text not null default '',
  last_seen timestamptz, created_at timestamptz not null default now()
);
create table public.print_jobs (
  id serial primary key, order_id uuid not null references public.orders(id) on delete cascade,
  order_item_id int not null references public.order_items(id) on delete cascade, copy_index int not null default 1,
  printer_id int references public.printers(id) on delete set null,
  status text not null default 'queued' check (status in ('queued', 'slicing', 'printing', 'done', 'failed', 'cancelled', 'paused')),
  slot int, gcode_path text, stats jsonb not null default '{}', attempts int not null default 0, error text,
  waiting_reason text not null default '', progress int not null default 0,
  created_at timestamptz not null default now(), started_at timestamptz, finished_at timestamptz, updated_at timestamptz not null default now()
);
create trigger print_jobs_updated before update on public.print_jobs for each row execute function public.set_updated_at();
alter table public.printer_types enable row level security;
alter table public.printers enable row level security;
alter table public.print_jobs enable row level security;
create policy "read printer types" on public.printer_types for select using (true);
create policy "admin printers" on public.printers for all using (public.is_admin()) with check (public.is_admin());
create policy "admin print jobs" on public.print_jobs for all using (public.is_admin()) with check (public.is_admin());
create policy "admin printer types" on public.printer_types for all using (public.is_admin()) with check (public.is_admin());
create index print_jobs_status_idx on public.print_jobs(status, created_at);

-- ---------------------------------------------------------------- audit log
create table public.audit_log (
  id bigserial primary key, user_id uuid, email text, action text not null, detail jsonb not null default '{}',
  ip text, created_at timestamptz not null default now()
);
alter table public.audit_log enable row level security;
create policy "admin reads audit" on public.audit_log for select using (public.is_admin());

-- ---------------------------------------------------------------- order numbers
create sequence public.order_number_seq start 100001;
create or replace function public.next_order_number() returns text language sql as $$
  select 'P2P-' || nextval('public.order_number_seq')::text;
$$;

-- ---------------------------------------------------------------- storage buckets
insert into storage.buckets (id, name, public) values ('media', 'media', true) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('models', 'models', false) on conflict (id) do nothing;
create policy "public media read" on storage.objects for select using (bucket_id = 'media');
-- 'models' has no client policies: only edge functions (service role) read and write it.
