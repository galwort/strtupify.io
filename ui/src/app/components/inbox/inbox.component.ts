import { Component, OnInit, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { InboxService, Email } from '../../services/inbox.service';

@Component({
  selector: 'app-inbox',
  templateUrl: './inbox.component.html',
  styleUrls: ['./inbox.component.scss'],
  imports: [CommonModule]
})
export class InboxComponent implements OnInit {
  @Input() companyId = '';

  inbox: Email[] = [];
  selectedEmail: Email | null = null;

  constructor(private route: ActivatedRoute, private inboxService: InboxService) {}

  ngOnInit(): void {
    if (!this.companyId) {
      console.error('companyId is empty');
      return;
    }

    this.inboxService.ensureWelcomeEmail(this.companyId).finally(() => {
      this.inboxService.getInbox(this.companyId).subscribe(emails => {
        this.inbox = emails;
        if (!this.selectedEmail && emails.length) this.selectedEmail = emails[0];
      });
    });
  }


  selectEmail(email: Email): void {
    this.selectedEmail = email;
  }

  deleteSelected(): void {
    if (this.selectedEmail) {
      this.inboxService.deleteEmail(this.companyId, this.selectedEmail.id);
      this.selectedEmail = null;
    }
  }
}
