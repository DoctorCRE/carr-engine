WITH relations AS (
  SELECT c.oid, n.nspname || '.' || c.relname AS name, c.relkind,
    c.relrowsecurity, c.relforcerowsecurity
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname IN ('public','ops') AND c.relkind IN ('r','p','v','m','S')
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass
      AND d.objid=c.oid AND d.deptype='e')
)
SELECT name, jsonb_build_object(
  'kind', relkind, 'rls', relrowsecurity, 'force_rls', relforcerowsecurity,
  'columns', (SELECT jsonb_agg(jsonb_build_array(a.attname,
    format_type(a.atttypid,a.atttypmod), a.attnotnull, a.attidentity, a.attgenerated,
    pg_get_expr(d.adbin,d.adrelid), co.collname) ORDER BY a.attnum)
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    LEFT JOIN pg_collation co ON co.oid=a.attcollation
    WHERE a.attrelid=r.oid AND a.attnum>0 AND NOT a.attisdropped),
  'constraints', (SELECT jsonb_agg(jsonb_build_array(conname,pg_get_constraintdef(oid)) ORDER BY conname)
    FROM pg_constraint WHERE conrelid=r.oid),
  'indexes', (SELECT jsonb_agg(pg_get_indexdef(indexrelid) ORDER BY indexrelid::regclass::text)
    FROM pg_index WHERE indrelid=r.oid),
  'triggers', (SELECT jsonb_agg(jsonb_build_array(pg_get_triggerdef(t.oid),tgenabled) ORDER BY tgname)
    FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE tgrelid=r.oid AND NOT tgisinternal AND n.nspname='public'),
  'policies', (SELECT jsonb_agg(jsonb_build_array(polname,polcmd,polpermissive,
    (SELECT array_agg(rolname ORDER BY rolname) FROM pg_roles WHERE oid=ANY(polroles)),
    pg_get_expr(polqual,polrelid),pg_get_expr(polwithcheck,polrelid)) ORDER BY polname)
    FROM pg_policy WHERE polrelid=r.oid),
  'view', CASE WHEN relkind IN ('v','m') THEN pg_get_viewdef(r.oid) END,
  'sequence', (SELECT jsonb_build_array(seqtypid::regtype::text,seqstart,seqincrement,
    seqmax,seqmin,seqcache,seqcycle) FROM pg_sequence WHERE seqrelid=r.oid)
)::text AS definition FROM relations r
UNION ALL
SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
  pg_get_functiondef(p.oid)
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname IN ('public') AND p.prokind IN ('f','p')
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass
    AND d.objid=p.oid AND d.deptype='e')
ORDER BY name
