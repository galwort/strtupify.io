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
  username: string = '';
  errorMessage = '';
  isSubmitting = false;

  constructor(private router: Router, private authService: AuthService) {}

  ngOnInit() {}

  async register() {
    this.errorMessage = '';
    if (!this.email || !this.password || !this.username) {
      this.errorMessage = 'Please provide an email, password, and username.';
      return;
    }

    this.isSubmitting = true;
    try {
      await this.authService.register(this.email, this.password, this.username);
      this.router.navigate(['/login']);
    } catch (error: any) {
      console.error(error);
      this.errorMessage =
        error?.message || 'Unable to register. Please try again later.';
    } finally {
      this.isSubmitting = false;
    }
  }

  navigateTo(page: string) {
    this.router.navigateByUrl(`/${page}`);
  }
}
