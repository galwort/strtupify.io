import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';

@Component({
  selector: 'app-endgame-overlay',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './endgame-overlay.component.html',
  styleUrls: ['./endgame-overlay.component.scss'],
})
export class EndgameOverlayComponent {
  @Input() active = false;
  @Input() sidebarColor = 'var(--theme-primary)';
  @Input() resetting = false;
  @Output() reset = new EventEmitter<void>();

  hoverCount = 0;
  btnLeft = 52;
  btnTop = 62;
  lockedIn = false;

  get hint(): string {
    if (this.resetting) return 'Rebooting the strtupify kernel...';
    return 'Tap reset to get back to work.';
  }

  nudge(): void {
    if (this.resetting) return;
    if (this.lockedIn) return;
    this.hoverCount++;
    if (this.hoverCount >= 5) {
      this.lockedIn = true;
      return;
    }
    this.btnLeft = 15 + Math.random() * 70;
    this.btnTop = 48 + Math.random() * 32;
  }

  clickReset(): void {
    if (this.resetting) return;
    this.lockedIn = true;
    this.reset.emit();
  }
}
