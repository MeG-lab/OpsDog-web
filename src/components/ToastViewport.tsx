import React from 'react';
import { CheckCircle2, Info, TriangleAlert, X } from 'lucide-react';
import { useToastStore } from '../stores';

const ICON_BY_TONE = {
  success: CheckCircle2,
  info: Info,
  error: TriangleAlert,
} as const;

const ToastViewport: React.FC = () => {
  const toasts = useToastStore((state) => state.toasts);
  const dismissToast = useToastStore((state) => state.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-viewport" aria-live="polite" aria-atomic="true">
      {toasts.map((toast) => {
        const Icon = ICON_BY_TONE[toast.tone];
        return (
          <div key={toast.id} className={`toast-item ${toast.tone}${toast.closing ? ' closing' : ''}`}>
            <div className="toast-item-main">
              <Icon size={16} />
              <span>{toast.message}</span>
            </div>
            <button
              type="button"
              className="toast-close-btn"
              onClick={() => dismissToast(toast.id)}
              aria-label="关闭提示"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
};

export default ToastViewport;
