-- docs/seed-topics.sql
-- Nạp 30 chủ đề chuẩn (TOPIC_NAMES trong docs/reference/classify-topics.mjs) vào bảng tags.
-- AN TOÀN: chỉ thêm, không sửa hay xóa tag cũ (IELTS, TOEIC, Beginner...). Chạy lại nhiều lần không lỗi.
-- Chạy (PowerShell, đã đặt $env:DATABASE_URL trong cửa sổ hiện tại):
--     psql $env:DATABASE_URL -f docs/seed-topics.sql
-- Kết quả cuối: topics_found phải bằng 30; total_tags bằng 47 nếu bảng còn nguyên 17 tag cũ.
BEGIN;

CREATE TEMP TABLE _topics (name text PRIMARY KEY) ON COMMIT DROP;

INSERT INTO _topics (name) VALUES
  -- Group 1: Foundations (A1/A2)
  ('core_language'), ('time_calendar'), ('colors_shapes'), ('greetings_social'),
  -- Group 2: People & Daily Life (A1/B1)
  ('family_relationships'), ('body_appearance'), ('emotions_feelings'), ('character_values'),
  ('food_drink'), ('home_household'), ('clothes_fashion'), ('transport_travel'),
  -- Group 3: World & Nature (A2/B1)
  ('animals_wildlife'), ('plants_nature'), ('weather_climate'), ('geography_places'),
  -- Group 4: Society & Culture (B1/B2)
  ('education_school'), ('work_career'), ('sports_recreation'), ('arts_entertainment'),
  ('media_communication'), ('shopping_commerce'),
  -- Group 5: Advanced (B2/C1)
  ('technology_digital'), ('science_research'), ('health_medicine'), ('business_economy'),
  ('politics_law'), ('environment_society'), ('psychology_mind'), ('academic_formal');

INSERT INTO tags (name)
SELECT name FROM _topics
ON CONFLICT (name) DO NOTHING;

SELECT
  (SELECT COUNT(*) FROM _topics t JOIN tags g ON g.name = t.name) AS topics_found,
  (SELECT COUNT(*) FROM tags)                                     AS total_tags;

COMMIT;
