import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-login',
  templateUrl: './login.page.html',
  styleUrls: ['./login.page.scss'],
  standalone: false,
})
export class LoginPage implements OnInit {
  email: string = '';
  password: string = '';
  errorMessage = '';
  isSubmitting = false;
  isGoogleSubmitting = false;

  constructor(private router: Router, private authService: AuthService) {}

  ngOnInit() {}

  async emailLogin() {
    this.errorMessage = '';
    if (!this.email || !this.password) {
      this.errorMessage = 'Please provide an email and password.';
      return;
    }

    this.isSubmitting = true;
    try {
      await this.authService.login(this.email, this.password);
      this.router.navigate(['/home']);
    } catch (error: any) {
      console.error(error);
      this.errorMessage =
        error?.message || 'Unable to sign in. Please try again later.';
    } finally {
      this.isSubmitting = false;
    }
  }

  async googleLogin() {
    this.errorMessage = '';
    this.isGoogleSubmitting = true;
    try {
      await this.authService.loginWithGoogle();
      this.router.navigate(['/home']);
    } catch (error: any) {
      console.error(error);
      this.errorMessage =
        error?.message || 'Google sign-in failed. Please try again later.';
    } finally {
      this.isGoogleSubmitting = false;
    }
  }
}
