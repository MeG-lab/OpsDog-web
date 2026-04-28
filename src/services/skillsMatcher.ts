/**
 * Skills Matching Service
 * 
 * Matches user input against registered skills using keyword and
 * semantic-like matching. Returns matched skills sorted by relevance.
 */

import type { Skill } from '../types';

export interface SkillMatch {
  skill: Skill;
  score: number;        // 0-1 relevance score
  matchedTrigger: string;
}

/**
 * Match user input against enabled skills.
 * Returns skills sorted by match score (descending).
 */
export function matchSkills(input: string, skills: Skill[]): SkillMatch[] {
  const enabledSkills = skills.filter((s) => s.enabled);
  if (!input.trim() || enabledSkills.length === 0) return [];

  const normalizedInput = input.toLowerCase().trim();
  const matches: SkillMatch[] = [];

  for (const skill of enabledSkills) {
    let bestScore = 0;
    let bestTrigger = '';

    for (const trigger of skill.triggers) {
      const normalizedTrigger = trigger.toLowerCase().trim();
      const score = calculateMatchScore(normalizedInput, normalizedTrigger);

      if (score > bestScore) {
        bestScore = score;
        bestTrigger = trigger;
      }
    }

    // Also check against skill name and description
    const nameScore = calculateMatchScore(normalizedInput, skill.name.toLowerCase());
    const descScore = calculateMatchScore(normalizedInput, skill.description.toLowerCase()) * 0.6;

    if (nameScore > bestScore) {
      bestScore = nameScore;
      bestTrigger = skill.name;
    }
    if (descScore > bestScore) {
      bestScore = descScore;
      bestTrigger = skill.description;
    }

    if (bestScore > 0.3) {
      matches.push({
        skill,
        score: bestScore,
        matchedTrigger: bestTrigger,
      });
    }
  }

  return matches.sort((a, b) => b.score - a.score);
}

/**
 * Calculate relevance score between input and trigger text.
 * Uses a combination of:
 * - Exact substring match (highest)
 * - Token overlap (medium)  
 * - Character n-gram overlap (lowest)
 */
function calculateMatchScore(input: string, trigger: string): number {
  // 1. Exact match or containment
  if (input === trigger) return 1.0;
  if (input.includes(trigger) || trigger.includes(input)) return 0.9;

  // 2. Token overlap (Jaccard-like)
  const inputTokens = tokenize(input);
  const triggerTokens = tokenize(trigger);

  if (inputTokens.length === 0 || triggerTokens.length === 0) return 0;

  const intersection = inputTokens.filter((t) => triggerTokens.includes(t));
  const union = new Set([...inputTokens, ...triggerTokens]);
  const tokenScore = intersection.length / union.size;

  // 3. Check if all trigger tokens are present in input
  const allTriggerTokensPresent = triggerTokens.every((t) =>
    inputTokens.some((it) => it.includes(t) || t.includes(it))
  );

  if (allTriggerTokensPresent && triggerTokens.length > 1) {
    return Math.max(tokenScore, 0.8);
  }

  // 4. Partial keyword match
  const partialMatches = triggerTokens.filter((t) =>
    inputTokens.some((it) => it.includes(t) || t.includes(it))
  );
  const partialScore = partialMatches.length / triggerTokens.length;

  return Math.max(tokenScore * 0.7, partialScore * 0.6);
}

/**
 * Tokenize Chinese and English text into meaningful tokens.
 * For Chinese: treat each character/word as a token.
 * For English: split by whitespace.
 */
function tokenize(text: string): string[] {
  // Split on whitespace and common punctuation
  const tokens = text
    .split(/[\s,，。！？、：；""''（）【】\-_/\\]+/)
    .filter((t) => t.length > 0);

  // For Chinese text, also split individual characters for better matching
  const expanded: string[] = [];
  for (const token of tokens) {
    expanded.push(token);
    // If token contains Chinese characters, also add individual chars
    const chineseChars = token.match(/[\u4e00-\u9fff]/g);
    if (chineseChars && chineseChars.length > 1) {
      // Add bigrams for better Chinese matching
      for (let i = 0; i < token.length - 1; i++) {
        const char = token[i];
        if (/[\u4e00-\u9fff]/.test(char)) {
          expanded.push(token.slice(i, i + 2));
        }
      }
    }
  }

  return [...new Set(expanded)];
}

/**
 * Build a system prompt that includes matched skill instructions.
 * This is injected into the LLM context to guide its behavior.
 */
export function buildSkillSystemPrompt(matchedSkills: SkillMatch[], instructions?: Map<string, string>): string {
  if (matchedSkills.length === 0) return '';

  const parts = [
    '你是 AIops智能运维中枢。以下是与用户需求匹配的可用技能：',
    '',
  ];

  for (const match of matchedSkills) {
    parts.push(`## Skill: ${match.skill.name} (v${match.skill.version})`);
    parts.push(`描述: ${match.skill.description}`);
    parts.push(`入口脚本: ${match.skill.entryScript}`);
    parts.push(`超时: ${match.skill.timeoutSeconds}秒`);

    if (match.skill.dependencies.length > 0) {
      parts.push(`依赖: ${match.skill.dependencies.join(', ')}`);
    }

    // Include detailed instructions if available
    const instruction = instructions?.get(match.skill.name);
    if (instruction) {
      parts.push('');
      parts.push('### 详细操作指南');
      parts.push(instruction);
    }

    parts.push('');
  }

  parts.push('---');
  parts.push('请根据以上技能信息，理解用户的运维需求并给出具体的操作方案。');
  parts.push('注意：Skill 的说明文档只用于告诉你脚本的位置、用途和使用方法，不代表脚本文件本身存放在 Skill 目录里。');
  parts.push('如果技能已经提供了执行结果，请先结合结果回答；如果参数不足，请明确向用户确认缺失信息。');

  return parts.join('\n');
}
