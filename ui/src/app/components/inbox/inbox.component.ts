import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-inbox',
  templateUrl: './inbox.component.html',
  styleUrls: ['./inbox.component.scss'],
  imports: [CommonModule]
})
export class InboxComponent  implements OnInit {

  constructor() { }

  // Dummy emails for inbox preview
  inbox = [
    { id: 1, sender: 'alice@company.com', subject: 'Quarterly Report', preview: 'The quarterly report is attached...', body: 'Hi team,\n\nPlease find the quarterly report attached. Let me know if you have any questions.\n\nBest,\nAlice' },
    { id: 2, sender: 'bob@company.com', subject: 'Team Meeting', preview: 'Reminder: team meeting at 3 PM today...', body: 'Hello everyone,\n\nThis is a reminder that our weekly team meeting is scheduled for today at 3 PM in the main conference room.\n\nThanks,\nBob' },
    { id: 3, sender: 'hr@company.com', subject: 'Policy Update', preview: 'Please review the updated policy on remote work...', body: 'Dear all,\n\nWe have updated our remote work policy. Please review the attached document and acknowledge receipt.\n\nRegards,\nHR' }
  ];

  selectedEmail: any = null;

  ngOnInit() {
    this.selectedEmail = this.inbox[0];
  }

  selectEmail(email: any) {
    this.selectedEmail = email;
  }

}
