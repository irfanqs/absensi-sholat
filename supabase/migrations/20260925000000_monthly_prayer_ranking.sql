create index if not exists attendances_class_date_idx on public.attendances(class_name, date);
create index if not exists students_class_name_idx on public.students(class_name, name);

create or replace function public.get_monthly_class_prayer_ranking(
  p_month date,
  p_class_name text default null
)
returns table (
  class_name text,
  student_count bigint,
  sholat_count bigint,
  haid_count bigint,
  absent_count bigint,
  expected_attendance bigint,
  percentage numeric
)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  with bounds as (
    select
      date_trunc('month', p_month)::date as start_date,
      (date_trunc('month', p_month) + interval '1 month - 1 day')::date as end_date
  ), month_days as (
    select (end_date - start_date + 1)::bigint as days
    from bounds
  ), class_students as (
    select
      s.class_name,
      count(*)::bigint as student_count
    from public.students s
    where p_class_name is null or s.class_name = p_class_name
    group by s.class_name
  ), class_attendances as (
    select
      a.class_name,
      count(a.id) filter (where a.status <> 'Haid')::bigint as sholat_count,
      count(a.id) filter (where a.status = 'Haid')::bigint as haid_count,
      count(a.id)::bigint as attendance_count
    from public.attendances a
    cross join bounds b
    where a.date >= b.start_date
      and a.date <= b.end_date
      and (p_class_name is null or a.class_name = p_class_name)
    group by a.class_name
  )
  select
    cs.class_name,
    cs.student_count,
    coalesce(ca.sholat_count, 0) as sholat_count,
    coalesce(ca.haid_count, 0) as haid_count,
    greatest((cs.student_count * md.days) - coalesce(ca.attendance_count, 0), 0) as absent_count,
    cs.student_count * md.days as expected_attendance,
    round(
      case
        when cs.student_count * md.days = 0 then 0
        else coalesce(ca.sholat_count, 0)::numeric * 100 / (cs.student_count * md.days)
      end,
      1
    ) as percentage
  from class_students cs
  cross join month_days md
  left join class_attendances ca on ca.class_name = cs.class_name
  order by percentage desc, sholat_count desc, cs.class_name asc;
$$;

revoke execute on function public.get_monthly_class_prayer_ranking(date, text) from public;
grant execute on function public.get_monthly_class_prayer_ranking(date, text) to anon, authenticated;

notify pgrst, 'reload schema';
