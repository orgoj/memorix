/**
 * Pattern Detector
 *
 * Analyzes text content to detect patterns worth remembering.
 * Inspired by mcp-memory-service's Smart Auto-Capture,
 * but works across all agents via the unified hooks system.
 */

import type { DetectedPattern, PatternType } from "./types.js";

/** Minimum content length to consider for pattern detection */
const MIN_CONTENT_LENGTH = 100;

/** Pattern definitions with multilingual keywords */
const PATTERNS: Array<{
  type: PatternType;
  keywords: RegExp[];
  minLength: number;
  baseConfidence: number;
}> = [
  {
    type: "decision",
    keywords: [
      // English
      /\b(decided|chose|will use|settled on|going with|picked|selected)\b/i,
      // Chinese
      /(决定|选择了|采用|确定用|最终选了)/,
      // Czech
      /\b(rozhodl|rozhodně|zvol|zvolil|vyber|vybral|použij|použijeme|budeme|používat|jde s|jedeme s|rozhodnutí|výběr)\b/i,
      // General terms
      /\b(architecture|approach|strategy|pattern|framework)\b/i,
    ],
    minLength: 100,
    baseConfidence: 0.8,
  },
  {
    type: "error",
    keywords: [
      // English
      /\b(error|bug|fix(ed)?|resolv(ed|ing)|crash|fail(ed|ure)?|broken)\b/i,
      // Chinese
      /(错误|修复|报错|崩溃|失败|异常|解决了)/,
      // Czech - vulgarity/frustration markers
      /\b(kurva|kurwa|WTF)\b/i,
      // Czech - general error terms
      /\b(nefunguje|chyba|problém|rozbit|selhal|selhání|pád|crash|nefunguje)\b/i,
      /\b(opravit|oprav|vyřešit|vyřeš|vyřeší)\b/i,
      /\b(rozbil|rozbít|rozbitý|poškodit|poškozený)\b/i,
      // General terms
      /\b(workaround|hotfix|patch|regression|stack\s*trace)\b/i,
    ],
    minLength: 100,
    baseConfidence: 0.75,
  },
  {
    type: "gotcha",
    keywords: [
      // English
      /\b(gotcha|pitfall|trap|caveat|watch out|careful|beware|warning)\b/i,
      // Chinese
      /(坑|注意|陷阱|小心|踩坑|坑点)/,
      // Czech - warnings
      /\b(pozor|nestraš|varování)\b/i,
      // Czech - prohibitions
      /\b(nesmí|nikdy|žádný)\b/i,
      // Czech - negative instructions
      /\b(nedělej|nedelat|neres|nehledej|nepis|nezkousej)\b/i,
      // English/Chinese prohibitions
      /\b(don'?t|never|avoid|must not|不要|千万别|切记)\b/i,
    ],
    minLength: 80,
    baseConfidence: 0.85,
  },
  {
    type: "configuration",
    keywords: [
      // English
      /\b(config(ured?|uration)?|setting|environment|\.env)\b/i,
      // Chinese
      /(配置|环境变量|端口配置|设置项|安装配置)/,
      // Czech
      /\b(nastav|konfigurac|env|prostředí|port|home)\b/i,
      // Czech servers/services
      /\b(docker|nginx|apache|ssl|tls|certifikát|certifikatu)\b/i,
      // General tools
      /\b(gradle|webpack|vite|tsconfig|package\.json)\b/i,
      // General patterns
      /\b(port\s*[:=]|listen\s+\d|bind\s+\d|DATABASE_URL|API_KEY)\b/i,
    ],
    minLength: 80,
    baseConfidence: 0.7,
  },
  {
    type: "learning",
    keywords: [
      // English
      /\b(learn(ed)?|discover(ed)?|realiz(ed)?|turns?\s*out|found\s*out|TIL)\b/i,
      // Chinese
      /(学到|发现|原来|才知道|了解到)/,
      // Czech
      /\b(zjistil|zjisti|nauci|naucil|naučil|pochopil|ukázal|ukaz|dozvěděl)\b/i,
      // Czech - surprise/realization
      /\b(vlastně|vlastne|překvapení|prekvapeni|zjistil|fakt|surprise)\b/i,
      // General
      /\b(insight|understanding|clarif(ied|ication))\b/i,
    ],
    minLength: 150,
    baseConfidence: 0.65,
  },
  {
    type: "implementation",
    keywords: [
      // English
      /\b(implement(ed)?|creat(ed|ing)|built|added|integrat(ed|ing))\b/i,
      // Chinese
      /(实现了|创建了|添加了|集成了|完成了)/,
      // Czech
      /\b(hotovo|hotový|udělal|udělaný|uděláno|přidal|implementoval|implementováno|vytvořil|vytvořen|vytvořeno)\b/i,
      // Czech - modifications
      /\b(refaktoroval|přepsal|přepsan|změnil|zmen|uprav|upravil|změn|změněn|upraven)\b/i,
      // Czech - migration/upgrade
      /\b(migroval|přenesl|presun|upgrad|upgradov|upgradovano)\b/i,
      // English refactoring
      /\b(refactor(ed)?|migrat(ed|ing)|upgrad(ed|ing))\b/i,
    ],
    minLength: 200,
    baseConfidence: 0.5,
  },
  {
    type: "deployment",
    keywords: [
      // English
      /\b(deploy(ed|ing|ment)?|ship(ped|ping)?|releas(ed|ing)|publish(ed|ing)?)\b/i,
      // Chinese
      /(部署|发布|上线|迁移|运维)/,
      // Czech
      /\b(nasadit|nasadil|nasazeno|publikovat|publikováno|zveřejněno|release)\b/i,
      // Czech - server/infrastructure
      /\b(server|hosting|vps|cloud|domena|dns|certifikat|certifikatu|doména)\b/i,
      // Infrastructure
      /\b(docker|compose|container|kubernetes|k8s|helm)\b/i,
      /\b(VPS|host(ing)?|cloud|AWS|Azure|GCP|Cloudflare)\b/i,
      /\b(nginx|caddy|apache|reverse.?proxy|load.?balanc)\b/i,
      /\b(SSL|TLS|cert(ificate)?|HTTPS|Let'?s?.?Encrypt|ACME)\b/i,
      /\b(DNS|domain|A.?record|CNAME|nameserver)\b/i,
      /\b(CI\/CD|pipeline|GitHub.?Actions|Jenkins|GitLab.?CI)\b/i,
      /\b(scp|rsync|ssh|sftp|systemd|systemctl|service)\b/i,
      // Chinese infrastructure
      /(服务器|域名|证书|反向代理|负载均衡|镜像|容器)/,
    ],
    minLength: 80,
    baseConfidence: 0.75,
  },
];

/**
 * Detect patterns in text content.
 * Returns matched patterns sorted by confidence (highest first).
 */
export function detectPatterns(content: string): DetectedPattern[] {
  if (!content || content.length < MIN_CONTENT_LENGTH) {
    return [];
  }

  const results: DetectedPattern[] = [];

  for (const pattern of PATTERNS) {
    if (content.length < pattern.minLength) continue;

    const matchedKeywords: string[] = [];
    let matchCount = 0;

    for (const regex of pattern.keywords) {
      const matches = content.match(
        new RegExp(regex.source, regex.flags + "g"),
      );
      if (matches) {
        matchCount += matches.length;
        matchedKeywords.push(...matches.map((m) => m.trim()));
      }
    }

    if (matchCount > 0) {
      // Confidence increases with more keyword matches (up to 1.0)
      const confidence = Math.min(
        1.0,
        pattern.baseConfidence + matchCount * 0.05,
      );
      results.push({
        type: pattern.type,
        confidence,
        matchedKeywords: [...new Set(matchedKeywords)].slice(0, 5),
      });
    }
  }

  // Sort by confidence descending
  results.sort((a, b) => b.confidence - a.confidence);

  return results;
}

/**
 * Get the best (highest confidence) pattern from content.
 * Returns null if no pattern is detected or confidence is too low.
 */
export function detectBestPattern(
  content: string,
  minConfidence = 0.5,
): DetectedPattern | null {
  const patterns = detectPatterns(content);
  if (patterns.length === 0) return null;
  if (patterns[0].confidence < minConfidence) return null;
  return patterns[0];
}

/**
 * Map pattern type → Memorix observation type.
 */
export function patternToObservationType(pattern: PatternType): string {
  const map: Record<PatternType, string> = {
    decision: "decision",
    error: "problem-solution",
    gotcha: "gotcha",
    configuration: "what-changed",
    learning: "discovery",
    implementation: "what-changed",
    deployment: "what-changed",
  };
  return map[pattern] ?? "discovery";
}
