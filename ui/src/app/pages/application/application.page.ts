import { Component, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';

@Component({
  selector: 'app-application',
  templateUrl: './application.page.html',
  styleUrls: ['./application.page.scss'],
  standalone: false,
})
export class ApplicationPage implements OnInit {
  companyName: string = '';
  companyDescription: string = '';

  constructor(private http: HttpClient) {}

  ngOnInit() {}

  onSubmit() {
    const url = 'https://fa-strtupifyio.azurewebsites.net/api/jobs';
    const body = { company_description: this.companyDescription };
    this.http.post(url, body).subscribe({
      next: (response) => console.log(response),
      error: (err) => console.error('Error:', err),
    });
  }
}
