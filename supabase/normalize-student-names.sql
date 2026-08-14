-- Run this once in Supabase SQL Editor to repair existing student names.
update public.students
set name = initcap(lower(trim(name)))
where name is not null;
