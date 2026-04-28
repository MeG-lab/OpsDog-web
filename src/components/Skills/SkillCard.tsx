import React from 'react';
import { Zap, ToggleLeft, ToggleRight, Clock, FileCode } from 'lucide-react';
import type { Skill } from '../../types';

interface SkillCardProps {
  skill: Skill;
  onToggle: (name: string) => void;
}

const SkillCard: React.FC<SkillCardProps> = ({ skill, onToggle }) => {
  return (
    <div
      className="rounded-2xl p-4 transition-all"
      style={{
        backgroundColor: 'var(--color-bg-card)',
        border: '1px solid var(--color-border-light)',
        boxShadow: 'var(--shadow-card)',
        opacity: skill.enabled ? 1 : 0.65,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.boxShadow = 'var(--shadow-card-hover)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.boxShadow = 'var(--shadow-card)'; }}
    >
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{
              backgroundColor: skill.enabled ? 'rgba(227, 183, 120, 0.15)' : 'var(--color-bg-secondary)',
            }}
          >
            <Zap size={16} style={{ color: skill.enabled ? 'var(--color-accent-warm)' : 'var(--color-text-tertiary)' }} />
          </div>
          <div>
            <h3 className="text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>
              {skill.name}
            </h3>
            <span className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
              v{skill.version}
            </span>
          </div>
        </div>
        <button
          onClick={() => onToggle(skill.name)}
          className="cursor-pointer transition-colors"
          style={{ color: skill.enabled ? 'var(--color-accent-warm)' : 'var(--color-text-tertiary)' }}
        >
          {skill.enabled ? <ToggleRight size={24} /> : <ToggleLeft size={24} />}
        </button>
      </div>

      <p className="text-sm mb-3 leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
        {skill.description}
      </p>

      <div className="flex flex-wrap gap-1.5 mb-3">
        {skill.triggers.map((trigger, i) => (
          <span
            key={i}
            className="px-2 py-0.5 rounded-md text-xs"
            style={{
              backgroundColor: 'var(--color-bg-secondary)',
              color: 'var(--color-text-tertiary)',
            }}
          >
            {trigger}
          </span>
        ))}
      </div>

      <div className="flex items-center gap-4 text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
        <div className="flex items-center gap-1">
          <FileCode size={12} />
          <span>{skill.entryScript}</span>
        </div>
        <div className="flex items-center gap-1">
          <Clock size={12} />
          <span>{skill.timeoutSeconds}s</span>
        </div>
      </div>
    </div>
  );
};

export default SkillCard;
