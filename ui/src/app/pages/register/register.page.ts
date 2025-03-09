import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-register',
  templateUrl: './register.page.html',
  styleUrls: ['./register.page.scss'],
  standalone: false,
})
export class RegisterPage implements OnInit {
  email: string = '';
  password: string = '';

  constructor(private router: Router, private authService: AuthService) {}

  ngOnInit() {}

  register() {
    this.authService
      .register(this.email, this.password)
      .then(() => {
        this.router.navigate(['/login']);
      })
      .catch((error) => {
        console.error(error);
      });
  }

  navigateTo(page: string) {
    this.router.navigateByUrl(`/${page}`);
  }
}
