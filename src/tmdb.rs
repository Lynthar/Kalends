use anyhow::{anyhow, Result};
use serde_json::{json, Value};

pub struct Tmdb {
    key: String,
    client: reqwest::Client,
}

fn join_names(v: &Value, take: usize) -> Option<String> {
    let list: Vec<&str> = v
        .as_array()?
        .iter()
        .filter_map(|x| x["name"].as_str())
        .take(take)
        .collect();
    (!list.is_empty()).then(|| list.join(" / "))
}

fn year_of(date: Option<&str>) -> Option<i64> {
    date.and_then(|s| s.get(..4)).and_then(|y| y.parse().ok())
}

impl Tmdb {
    pub fn new(key: &str, proxy: &str) -> Result<Self> {
        if key.trim().is_empty() {
            return Err(anyhow!("未配置 TMDB API Key（设置页 → 元数据）"));
        }
        Ok(Self {
            key: key.trim().to_string(),
            client: crate::notify::http_client(proxy)?,
        })
    }

    async fn get(&self, path: &str, extra: &[(&str, &str)]) -> Result<Value> {
        let mut req = self
            .client
            .get(format!("https://api.themoviedb.org/3{path}"))
            .query(&[("language", "zh-CN")])
            .query(extra);
        // v4 令牌是含点号的 JWT，走 Bearer；v3 短 key 走查询参数
        if self.key.contains('.') {
            req = req.bearer_auth(&self.key);
        } else {
            req = req.query(&[("api_key", self.key.as_str())]);
        }
        let resp = req.send().await?;
        if !resp.status().is_success() {
            return Err(anyhow!(
                "TMDB {}: {}",
                resp.status(),
                resp.text().await.unwrap_or_default()
            ));
        }
        Ok(resp.json().await?)
    }

    pub async fn search(&self, tv: bool, q: &str) -> Result<Vec<Value>> {
        let d = self
            .get(if tv { "/search/tv" } else { "/search/movie" }, &[("query", q)])
            .await?;
        let empty = Vec::new();
        Ok(d["results"]
            .as_array()
            .unwrap_or(&empty)
            .iter()
            .take(8)
            .map(|r| {
                json!({
                    "tmdb_id": r["id"],
                    "title": r[if tv { "name" } else { "title" }],
                    "orig_title": r[if tv { "original_name" } else { "original_title" }],
                    "year": year_of(r[if tv { "first_air_date" } else { "release_date" }].as_str()),
                    "poster": r["poster_path"],
                    "overview": r["overview"],
                })
            })
            .collect())
    }

    /// 返回（映射好的媒体字段，海报路径）。
    pub async fn details(&self, tv: bool, id: i64) -> Result<(Value, Option<String>)> {
        let d = self
            .get(
                &format!("/{}/{id}", if tv { "tv" } else { "movie" }),
                &[("append_to_response", "credits,external_ids")],
            )
            .await?;
        let title = d[if tv { "name" } else { "title" }].as_str().unwrap_or("");
        let orig = d[if tv { "original_name" } else { "original_title" }]
            .as_str()
            .filter(|o| *o != title);
        let date = d[if tv { "first_air_date" } else { "release_date" }].as_str();
        let runtime = if tv {
            match (d["number_of_seasons"].as_i64(), d["number_of_episodes"].as_i64()) {
                (Some(s), Some(e)) => Some(format!("{s}季 / {e}集")),
                _ => None,
            }
        } else {
            d["runtime"].as_i64().filter(|n| *n > 0).map(|n| format!("{n}分钟"))
        };
        let directors = if tv {
            join_names(&d["created_by"], 4)
        } else {
            d["credits"]["crew"].as_array().map(|crew| {
                crew.iter()
                    .filter(|c| c["job"].as_str() == Some("Director"))
                    .filter_map(|c| c["name"].as_str())
                    .collect::<Vec<_>>()
                    .join(" / ")
            }).filter(|s| !s.is_empty())
        };
        let writers = (!tv)
            .then(|| {
                d["credits"]["crew"].as_array().map(|crew| {
                    let mut seen = Vec::new();
                    for c in crew {
                        if matches!(c["job"].as_str(), Some("Writer" | "Screenplay" | "Story")) {
                            if let Some(n) = c["name"].as_str() {
                                if !seen.contains(&n) {
                                    seen.push(n);
                                }
                            }
                        }
                    }
                    seen.join(" / ")
                })
            })
            .flatten()
            .filter(|s| !s.is_empty());
        let countries = if tv {
            d["origin_country"].as_array().map(|a| {
                a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(" / ")
            }).filter(|s| !s.is_empty())
        } else {
            join_names(&d["production_countries"], 6)
        };
        let imdb = if tv {
            d["external_ids"]["imdb_id"].as_str()
        } else {
            d["imdb_id"].as_str()
        };
        let fields = json!({
            "title": title,
            "orig_title": orig,
            "year": year_of(date),
            "release_date": date,
            "runtime": runtime,
            "genres": join_names(&d["genres"], 8),
            "countries": countries,
            "languages": d["original_language"],
            "directors": directors,
            "writers": writers,
            "actors": join_names(&d["credits"]["cast"], 6),
            "imdb_id": imdb,
            "tmdb_id": id,
        });
        Ok((fields, d["poster_path"].as_str().map(String::from)))
    }

    pub async fn poster(&self, path: &str) -> Result<Vec<u8>> {
        let resp = self
            .client
            .get(format!("https://image.tmdb.org/t/p/w500{path}"))
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(anyhow!("海报下载失败：{}", resp.status()));
        }
        Ok(resp.bytes().await?.to_vec())
    }
}
