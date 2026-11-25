import { Icon } from "@/components/icons/icon";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useLocale } from "@/hooks/use-locale";
import { setEnterSends, useEnterSendsChoice } from "@/lib/enter-sends-store";
import { t } from "@/lib/i18n";

/**
 * Whether a bare Enter from a physical keyboard sends the reply (ADR 0157, lib/enter-key.ts).
 * A tap stores the device's choice for replies governed by this setting.
 * The one-time offer above the reply box writes the same value. Per device, and never written to a bridge.
 */
export function EnterSendsControl() {
  useLocale();
  const on = useEnterSendsChoice() === "on";

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Icon name="send" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.enterSends.title")}</div>
            <p className="text-sm text-muted-foreground">{t("settings.enterSends.hint")}</p>
          </div>
        </div>
        <Switch checked={on} onCheckedChange={setEnterSends} aria-label={t("settings.enterSends.title")} />
      </div>
    </Card>
  );
}
