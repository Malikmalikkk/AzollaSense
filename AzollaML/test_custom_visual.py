import os
import cv2
import numpy as np
from ultralytics import YOLO

def analyze_and_draw(image_path, result):
    # Load original image
    img = cv2.imread(image_path)
    h, w, _ = img.shape
    total_pixels = h * w

    # Render prediction masks while hiding confidence boxes and class labels
    annotated_img = result.plot(conf=False, labels=False)

    green_pct = 0.0
    brown_pct = 0.0

    if result.masks is not None and result.boxes is not None:
        masks_array = result.masks.data.cpu().numpy()
        classes = result.boxes.cls.cpu().numpy()

        # Class 0: Brown / Browning Azolla
        if 0 in classes:
            brown_mask = np.any(masks_array[classes == 0], axis=0)
            brown_mask = cv2.resize(brown_mask.astype(np.uint8), (w, h), interpolation=cv2.INTER_NEAREST)
            brown_pct = (np.sum(brown_mask) / total_pixels) * 100

        # Class 1: Green Azolla
        if 1 in classes:
            green_mask = np.any(masks_array[classes == 1], axis=0)
            green_mask = cv2.resize(green_mask.astype(np.uint8), (w, h), interpolation=cv2.INTER_NEAREST)
            green_pct = (np.sum(green_mask) / total_pixels) * 100

    # --- Draw Custom Info Banner on Top of the Image ---
    banner_height = 80
    overlay = annotated_img.copy()
    cv2.rectangle(overlay, (0, 0), (w, banner_height), (0, 0, 0), -1)

    # Apply semi-transparent dark banner
    alpha = 0.6
    cv2.addWeighted(overlay, alpha, annotated_img, 1 - alpha, 0, annotated_img)

    # Format percentage text
    text_green = f"Green Azolla: {green_pct:.2f}%"
    text_brown = f"Browning Azolla: {brown_pct:.2f}%"
    text_total = f"Total Coverage: {(green_pct + brown_pct):.2f}%"

    # Overlay Text (Green in green, Brown in orange)
    cv2.putText(annotated_img, text_green, (20, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
    cv2.putText(annotated_img, text_brown, (20, 65), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 165, 255), 2)
    cv2.putText(annotated_img, text_total, (w - 300, 45), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)

    return annotated_img, green_pct, brown_pct

def main():
    # Update this path if testing the NCNN model folder instead of .pt
    model_path = '../runs/segment/train/weights/best.pt'
    test_images_dir = 'AzollaSense.v1/test/images'
    output_dir = 'custom_test_results'

    os.makedirs(output_dir, exist_ok=True)

    model = YOLO(model_path)
    images = [f for f in os.listdir(test_images_dir) if f.lower().endswith(('.jpg', '.png', '.jpeg'))]

    print(f"\nProcessing {len(images)} test images...\n")
    print(f"{'Filename':<25} | {'Green %':<10} | {'Browning %':<12} | {'Total %':<10}")
    print("-" * 65)

    for img_name in images:
        img_path = os.path.join(test_images_dir, img_name)

        # Run inference
        result = model(img_path, verbose=False)[0]

        # Process custom percentage calculations and draw banner
        annotated_img, g_pct, b_pct = analyze_and_draw(img_path, result)

        # Save annotated image
        output_path = os.path.join(output_dir, f"analyzed_{img_name}")
        cv2.imwrite(output_path, annotated_img)

        print(f"{img_name[:23]:<25} | {g_pct:>8.2f}% | {b_pct:>10.2f}% | {(g_pct+b_pct):>8.2f}%")

    print(f"\nDone! Processed images with coverage overlays saved to: {output_dir}/")

if __name__ == '__main__':
    main()